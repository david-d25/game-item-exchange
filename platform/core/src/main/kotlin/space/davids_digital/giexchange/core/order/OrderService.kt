package space.davids_digital.giexchange.core.order

import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import space.davids_digital.giexchange.contracts.AssetId
import space.davids_digital.giexchange.contracts.CancelOrder
import space.davids_digital.giexchange.contracts.CloseReason
import space.davids_digital.giexchange.contracts.CommandId
import space.davids_digital.giexchange.contracts.Credits
import space.davids_digital.giexchange.contracts.MarketKey
import space.davids_digital.giexchange.contracts.OrderCommand
import space.davids_digital.giexchange.contracts.OrderId
import space.davids_digital.giexchange.contracts.PlaceOrder
import space.davids_digital.giexchange.contracts.Side
import space.davids_digital.giexchange.contracts.TakeListing
import space.davids_digital.giexchange.contracts.TimeInForce
import space.davids_digital.giexchange.contracts.UserId
import space.davids_digital.giexchange.core.api.conflict
import space.davids_digital.giexchange.core.api.invalidRequest
import space.davids_digital.giexchange.core.api.notFound
import space.davids_digital.giexchange.core.api.unprocessable
import space.davids_digital.giexchange.core.ledger.AccountKind
import space.davids_digital.giexchange.core.ledger.InsufficientFundsException
import space.davids_digital.giexchange.core.ledger.Ledger
import space.davids_digital.giexchange.core.ledger.LedgerTxKind
import space.davids_digital.giexchange.core.outbox.Outbox
import java.sql.ResultSet
import java.sql.Types
import java.time.Clock
import java.time.Instant
import java.time.OffsetDateTime

enum class OrderStatus { PENDING, OPEN, CLOSED }

enum class ItemKind { UNIQUE, FUNGIBLE }

enum class OrderFilter { ACTIVE, CLOSED, ALL }

data class PlacementResult(val orderId: Long, val status: OrderStatus, val created: Boolean)

data class OrderView(
    val orderId: Long,
    val clientOrderId: String,
    val marketId: Long,
    val side: Side,
    val price: Long,
    val quantity: Long,
    val filled: Long,
    val timeInForce: TimeInForce,
    val assetId: Long?,
    val targetOrderId: Long?,
    val status: OrderStatus,
    val closeReason: CloseReason?,
    val createdAt: Instant,
)

@Service
class OrderService(
    private val jdbc: JdbcClient,
    private val ledger: Ledger,
    private val outbox: Outbox,
    private val clock: Clock,
) {
    /**
     * Accepts an order: stores it, reserves what it needs and queues the command for the matcher,
     * all in one transaction. Any failure rolls everything back and leaves no trace.
     * Repeating a request with the same clientOrderId returns the existing order.
     */
    @Transactional
    fun place(userId: UserId, request: PlaceOrderRequest): PlacementResult {
        validateNumbers(request)
        val market = findMarket(request.marketId) ?: throw notFound("Market ${request.marketId}")
        if (!market.tradable || market.gameStatus != "ACTIVE") {
            throw unprocessable("market-closed", "Market closed", "Market ${market.id} is not open for trading")
        }
        val order = normalize(request, market)
        if (order.targetOrderId != null) {
            checkTarget(userId, market, order)
        }

        // The order goes first: if this clientOrderId was already used, nothing else must happen
        val orderId = insertOrder(userId, market, order) ?: return repeatedRequest(userId, market, order)

        when {
            order.side == Side.BUY -> reserveCredits(userId, orderId, order)
            market.kind == ItemKind.FUNGIBLE -> reserveItems(userId, market, order)
            else -> listAsset(userId, market, order)
        }

        outbox.append(command(userId, market, orderId, order))
        return PlacementResult(orderId, OrderStatus.PENDING, created = true)
    }

    /**
     * Asks the matcher to cancel the unfilled remainder. The reservation is released only when
     * the matcher confirms: a trade for this order may already be on its way.
     */
    @Transactional
    fun requestCancel(userId: UserId, orderId: Long) {
        val order = jdbc.sql("select market_key, status from orders where order_id = :id and owner_id = :owner for update")
            .param("id", orderId)
            .param("owner", userId.value)
            .query { rs, _ -> rs.getString("market_key") to OrderStatus.valueOf(rs.getString("status")) }
            .optional()
            .orElse(null)
            ?: throw notFound("Order $orderId")

        val (marketKey, status) = order
        if (status == OrderStatus.CLOSED) {
            throw conflict("order-closed", "Order closed", "Order $orderId is already closed")
        }
        outbox.append(
            CancelOrder(
                commandId = nextCommandId(),
                marketKey = MarketKey(marketKey),
                issuedAt = clock.millis(),
                orderId = OrderId(orderId),
            )
        )
    }

    @Transactional(readOnly = true)
    fun get(userId: UserId, orderId: Long): OrderView =
        jdbc.sql(
            """
            select o.*, m.market_id from orders o join markets m using (market_key)
            where o.order_id = :id and o.owner_id = :owner
            """
        )
            .param("id", orderId)
            .param("owner", userId.value)
            .query { rs, _ -> orderView(rs) }
            .optional()
            .orElseThrow { notFound("Order $orderId") }

    /** The user's orders, newest first. */
    @Transactional(readOnly = true)
    fun list(userId: UserId, filter: OrderFilter, marketId: Long?, limit: Int): List<OrderView> {
        if (limit !in 1..MAX_LIST_LIMIT) {
            throw invalidRequest("limit must be between 1 and $MAX_LIST_LIMIT")
        }
        // One of three constants, never taken from the request
        val statusCondition = when (filter) {
            OrderFilter.ACTIVE -> "and o.status <> 'CLOSED'"
            OrderFilter.CLOSED -> "and o.status = 'CLOSED'"
            OrderFilter.ALL -> ""
        }
        return jdbc.sql(
            """
            select o.*, m.market_id from orders o join markets m using (market_key)
            where o.owner_id = :owner $statusCondition
              and (cast(:marketId as bigint) is null or m.market_id = :marketId)
            order by o.created_at desc, o.order_id desc
            limit :limit
            """
        )
            .param("owner", userId.value)
            .param("marketId", marketId, Types.BIGINT)
            .param("limit", limit)
            .query { rs, _ -> orderView(rs) }
            .list()
    }

    private fun orderView(rs: ResultSet) = OrderView(
        orderId = rs.getLong("order_id"),
        clientOrderId = rs.getString("client_order_id"),
        marketId = rs.getLong("market_id"),
        side = Side.valueOf(rs.getString("side")),
        price = rs.getLong("price"),
        quantity = rs.getLong("quantity"),
        filled = rs.getLong("filled"),
        timeInForce = TimeInForce.valueOf(rs.getString("time_in_force")),
        assetId = (rs.getObject("asset_id") as Number?)?.toLong(),
        targetOrderId = (rs.getObject("target_order_id") as Number?)?.toLong(),
        status = OrderStatus.valueOf(rs.getString("status")),
        closeReason = rs.getString("close_reason")?.let(CloseReason::valueOf),
        createdAt = rs.getObject("created_at", OffsetDateTime::class.java).toInstant(),
    )

    private fun validateNumbers(request: PlaceOrderRequest) {
        if (request.clientOrderId.length !in 1..64) {
            throw invalidRequest("clientOrderId must be 1 to 64 characters long")
        }
        if (request.price !in 1..MAX_PRICE) {
            throw invalidRequest("price must be between 1 and $MAX_PRICE")
        }
        if (request.quantity !in 1..MAX_QUANTITY) {
            throw invalidRequest("quantity must be between 1 and $MAX_QUANTITY")
        }
    }

    private fun findMarket(marketId: Long): Market? =
        jdbc.sql(
            """
            select m.market_id, m.market_key, d.kind, d.tradable, g.status as game_status
            from markets m
            join item_definitions d using (game_id, def_id)
            join games g using (game_id)
            where m.market_id = :id
            """
        )
            .param("id", marketId)
            .query { rs, _ ->
                Market(
                    id = rs.getLong("market_id"),
                    key = rs.getString("market_key"),
                    kind = ItemKind.valueOf(rs.getString("kind")),
                    tradable = rs.getBoolean("tradable"),
                    gameStatus = rs.getString("game_status"),
                )
            }
            .optional()
            .orElse(null)

    /** Checks that the order makes sense for this kind of market and brings it to its stored form. */
    private fun normalize(request: PlaceOrderRequest, market: Market): PlaceOrderRequest {
        val take = request.targetOrderId != null
        when (market.kind) {
            ItemKind.FUNGIBLE -> {
                if (request.assetId != null) {
                    throw invalidRequest("assetId is not allowed in a market of fungible items")
                }
                if (take) {
                    throw invalidRequest("Buying a specific listing is only possible in a market of unique items")
                }
            }
            ItemKind.UNIQUE -> {
                if (request.side == Side.SELL && (request.assetId == null || request.quantity != 1L)) {
                    throw invalidRequest("A sell order of a unique item needs assetId and quantity 1")
                }
                if (request.side == Side.BUY && request.assetId != null) {
                    throw invalidRequest("assetId is only allowed in sell orders")
                }
                if (take && (request.side != Side.BUY || request.quantity != 1L)) {
                    throw invalidRequest("Buying a specific listing needs side BUY and quantity 1")
                }
            }
        }
        // Buying a specific listing happens right away or not at all
        return if (take) request.copy(timeInForce = TimeInForce.IOC) else request
    }

    /**
     * Early check with a clear error for the user. The matcher still has the final word:
     * the listing may be bought by someone else before this command reaches it.
     */
    private fun checkTarget(userId: UserId, market: Market, order: PlaceOrderRequest) {
        val target = jdbc.sql("select market_key, side, price, owner_id, status from orders where order_id = :id")
            .param("id", order.targetOrderId)
            .query { rs, _ ->
                TargetOrder(
                    marketKey = rs.getString("market_key"),
                    side = Side.valueOf(rs.getString("side")),
                    price = rs.getLong("price"),
                    ownerId = rs.getLong("owner_id"),
                    status = OrderStatus.valueOf(rs.getString("status")),
                )
            }
            .optional()
            .orElse(null)

        if (target == null || target.marketKey != market.key || target.side != Side.SELL || target.status != OrderStatus.OPEN) {
            throw conflict("listing-unavailable", "Listing unavailable", "Listing ${order.targetOrderId} is no longer available")
        }
        if (target.ownerId == userId.value) {
            throw unprocessable("own-listing", "Own listing", "You cannot buy your own listing")
        }
        if (target.price != order.price) {
            throw conflict("listing-price-changed", "Listing price changed", "The listing costs ${target.price}, not ${order.price}")
        }
    }

    /** Returns the new order id, or null if this user already placed an order with this clientOrderId. */
    private fun insertOrder(userId: UserId, market: Market, order: PlaceOrderRequest): Long? =
        jdbc.sql(
            """
            insert into orders (client_order_id, market_key, owner_id, side, price, quantity,
                                time_in_force, asset_id, target_order_id)
            values (:clientOrderId, :marketKey, :ownerId, :side, :price, :quantity,
                    :timeInForce, :assetId, :targetOrderId)
            on conflict (owner_id, client_order_id) do nothing
            returning order_id
            """
        )
            .param("clientOrderId", order.clientOrderId)
            .param("marketKey", market.key)
            .param("ownerId", userId.value)
            .param("side", order.side.name)
            .param("price", order.price)
            .param("quantity", order.quantity)
            .param("timeInForce", order.timeInForce.name)
            .param("assetId", order.assetId, Types.BIGINT)
            .param("targetOrderId", order.targetOrderId, Types.BIGINT)
            .query(Long::class.javaObjectType)
            .optional()
            .orElse(null)

    /** A retry of an earlier request is fine; the same clientOrderId with different parameters is a client bug. */
    private fun repeatedRequest(userId: UserId, market: Market, order: PlaceOrderRequest): PlacementResult {
        val existing = jdbc.sql(
            """
            select order_id, market_key, side, price, quantity, time_in_force, asset_id, target_order_id, status
            from orders where owner_id = :owner and client_order_id = :clientOrderId
            """
        )
            .param("owner", userId.value)
            .param("clientOrderId", order.clientOrderId)
            .query { rs, _ ->
                val same = rs.getString("market_key") == market.key &&
                    rs.getString("side") == order.side.name &&
                    rs.getLong("price") == order.price &&
                    rs.getLong("quantity") == order.quantity &&
                    rs.getString("time_in_force") == order.timeInForce.name &&
                    (rs.getObject("asset_id") as Number?)?.toLong() == order.assetId &&
                    (rs.getObject("target_order_id") as Number?)?.toLong() == order.targetOrderId
                Triple(rs.getLong("order_id"), OrderStatus.valueOf(rs.getString("status")), same)
            }
            .single()

        val (orderId, status, same) = existing
        if (!same) {
            throw conflict(
                "client-order-id-reused",
                "clientOrderId reused",
                "clientOrderId ${order.clientOrderId} was already used for a different order",
            )
        }
        return PlacementResult(orderId, status, created = false)
    }

    private fun reserveCredits(userId: UserId, orderId: Long, order: PlaceOrderRequest) {
        val amount = Math.multiplyExact(order.price, order.quantity)
        val available = ledger.userAccount(userId, AccountKind.AVAILABLE)
        val reserved = ledger.userAccount(userId, AccountKind.RESERVED)
        try {
            ledger.post(LedgerTxKind.RESERVE, "order:$orderId", available to -amount, reserved to amount)
        } catch (e: InsufficientFundsException) {
            throw unprocessable(
                "insufficient-funds",
                "Insufficient funds",
                "The order requires $amount credits, ${e.balance} available",
            )
        }
    }

    private fun reserveItems(userId: UserId, market: Market, order: PlaceOrderRequest) {
        val updated = jdbc.sql(
            """
            update balances set available = available - :quantity, reserved = reserved + :quantity
            where owner_id = :owner and market_key = :market and available >= :quantity
            """
        )
            .param("quantity", order.quantity)
            .param("owner", userId.value)
            .param("market", market.key)
            .update()
        if (updated == 0) {
            throw unprocessable("insufficient-items", "Insufficient items", "You do not have ${order.quantity} items to sell")
        }
    }

    private fun listAsset(userId: UserId, market: Market, order: PlaceOrderRequest) {
        val updated = jdbc.sql(
            """
            update assets set state = 'LISTED'
            where asset_id = :asset and owner_id = :owner and market_key = :market and state = 'AVAILABLE'
            """
        )
            .param("asset", order.assetId)
            .param("owner", userId.value)
            .param("market", market.key)
            .update()
        if (updated == 0) {
            throw unprocessable(
                "item-unavailable",
                "Item unavailable",
                "Item ${order.assetId} is not available for sale in this market",
            )
        }
    }

    private fun command(userId: UserId, market: Market, orderId: Long, order: PlaceOrderRequest): OrderCommand {
        val commandId = nextCommandId()
        val marketKey = MarketKey(market.key)
        val issuedAt = clock.millis()
        val targetOrderId = order.targetOrderId
        return if (targetOrderId != null) {
            TakeListing(
                commandId = commandId,
                marketKey = marketKey,
                issuedAt = issuedAt,
                orderId = OrderId(orderId),
                ownerId = userId,
                targetOrderId = OrderId(targetOrderId),
                price = Credits(order.price),
            )
        } else {
            PlaceOrder(
                commandId = commandId,
                marketKey = marketKey,
                issuedAt = issuedAt,
                orderId = OrderId(orderId),
                ownerId = userId,
                side = order.side,
                price = Credits(order.price),
                quantity = order.quantity,
                assetId = order.assetId?.let(::AssetId),
                timeInForce = order.timeInForce,
            )
        }
    }

    private fun nextCommandId(): CommandId =
        CommandId(jdbc.sql("select nextval('command_id_seq')").query(Long::class.javaObjectType).single())

    private data class Market(
        val id: Long,
        val key: String,
        val kind: ItemKind,
        val tradable: Boolean,
        val gameStatus: String,
    )

    private data class TargetOrder(
        val marketKey: String,
        val side: Side,
        val price: Long,
        val ownerId: Long,
        val status: OrderStatus,
    )

    companion object {
        // Small enough that price × quantity always fits in a Long
        const val MAX_PRICE = 1_000_000_000L
        const val MAX_QUANTITY = 1_000_000_000L
        const val MAX_LIST_LIMIT = 200
    }
}
