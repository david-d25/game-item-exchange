package space.davids_digital.giexchange.core.settlement

import io.micrometer.core.instrument.Counter
import io.micrometer.core.instrument.MeterRegistry
import io.micrometer.core.instrument.Timer
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.slf4j.LoggerFactory
import org.springframework.beans.factory.annotation.Value
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.kafka.annotation.KafkaListener
import org.springframework.stereotype.Component
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import space.davids_digital.giexchange.contracts.CancelRejected
import space.davids_digital.giexchange.contracts.ContractsJson
import space.davids_digital.giexchange.contracts.MatchResult
import space.davids_digital.giexchange.contracts.OrderClosed
import space.davids_digital.giexchange.contracts.OrderId
import space.davids_digital.giexchange.contracts.OrderRested
import space.davids_digital.giexchange.contracts.Side
import space.davids_digital.giexchange.contracts.Topics
import space.davids_digital.giexchange.contracts.TradeExecuted
import space.davids_digital.giexchange.contracts.UserId
import space.davids_digital.giexchange.core.ledger.AccountKind
import space.davids_digital.giexchange.core.ledger.Ledger
import space.davids_digital.giexchange.core.ledger.LedgerTxKind
import space.davids_digital.giexchange.core.market.MarketEvents
import space.davids_digital.giexchange.core.order.OrderStatus
import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneOffset

@Component
@ConditionalOnProperty("giexchange.settlement.enabled", havingValue = "true", matchIfMissing = true)
class SettlementListener(private val settlement: Settlement) {
    @KafkaListener(topics = [Topics.MATCH_RESULTS], groupId = "settlement")
    fun onResult(payload: String) {
        settlement.apply(ContractsJson.decodeFromString<MatchResult>(payload))
    }
}

/**
 * Applies match results to the core database. Relies on the order of results described in [MatchResult]:
 * all trades of an order arrive before the order is closed.
 *
 * Any inconsistency between the matcher and core stops processing with an exception instead of
 * being smoothed over: moving money on top of an inconsistency only makes it worse.
 */
@Service
class Settlement(
    private val jdbc: JdbcClient,
    private val ledger: Ledger,
    private val marketEvents: MarketEvents,
    private val clock: Clock,
    registry: MeterRegistry,
    @Value($$"${giexchange.fees.trade-bps}") private val feeBps: Long,
) {
    private val log = LoggerFactory.getLogger(javaClass)

    private val settlementDelay = Timer.builder("exchange.settlement.delay")
        .description("Time from core accepting a command to settling a result of it")
        .publishPercentileHistogram()
        .register(registry)
    private val trades = Counter.builder("exchange.trades")
        .description("Settled trades")
        .register(registry)
    private val tradedCredits = Counter.builder("exchange.traded.credits")
        .description("Credits paid in settled trades")
        .register(registry)

    init {
        require(feeBps in 0..10_000) { "Trade fee must be between 0 and 10000 basis points: $feeBps" }
    }

    /** Every result is applied exactly once: a repeated one is recognized by its id and skipped. */
    @Transactional
    fun apply(result: MatchResult) {
        val firstTime = jdbc.sql("insert into processed_match_results (result_id) values (:id) on conflict do nothing")
            .param("id", result.resultId.value)
            .update() == 1
        if (!firstTime) {
            log.debug("Match result {} was already applied, skipping", result.resultId.value)
            return
        }

        settlementDelay.record(Duration.ofMillis(clock.millis() - result.occurredAt))

        when (result) {
            is TradeExecuted -> settleTrade(result)
            is OrderRested -> openOrder(result)
            is OrderClosed -> closeOrder(result)
            is CancelRejected ->
                log.info("Cancel of order {} rejected by the matcher: it was no longer in the book", result.orderId.value)
        }
    }

    private fun settleTrade(trade: TradeExecuted) {
        val orders = lockOrders(listOf(trade.buyOrderId, trade.sellOrderId))
        val buy = orders.getValue(trade.buyOrderId)
        val sell = orders.getValue(trade.sellOrderId)
        check(buy.side == Side.BUY && sell.side == Side.SELL) { "Trade ${trade.resultId.value} has wrong order sides" }
        check(buy.ownerId == trade.buyerId.value && sell.ownerId == trade.sellerId.value) {
            "Trade ${trade.resultId.value} has owners that differ from core"
        }
        check(trade.assetId?.value == sell.assetId) {
            "Trade ${trade.resultId.value} moves an item the sell order does not hold"
        }

        val buyer = UserId(buy.ownerId)
        val seller = UserId(sell.ownerId)

        // Credits. The buyer reserved at their limit price and pays the trade price; the difference goes back to them.
        val cost = Math.multiplyExact(trade.price.amount, trade.quantity)
        val released = Math.multiplyExact(buy.price, trade.quantity)
        val fee = feeOf(cost)
        ledger.post(
            LedgerTxKind.TRADE,
            "trade:${trade.resultId.value}",
            ledger.userAccount(buyer, AccountKind.RESERVED) to -released,
            ledger.userAccount(buyer, AccountKind.AVAILABLE) to released - cost,
            ledger.userAccount(seller, AccountKind.AVAILABLE) to cost - fee,
            ledger.platformAccount(AccountKind.FEES) to fee,
        )

        // Items
        val assetId = trade.assetId
        if (assetId != null) {
            val moved = jdbc.sql(
                """
                update assets set owner_id = :buyer, state = 'AVAILABLE', version = version + 1
                where asset_id = :asset and owner_id = :seller and state = 'LISTED'
                """
            )
                .param("buyer", buyer.value)
                .param("seller", seller.value)
                .param("asset", assetId.value)
                .update()
            check(moved == 1) { "Item ${assetId.value} of trade ${trade.resultId.value} is not listed by the seller" }
        } else {
            val taken = jdbc.sql(
                """
                update balances set reserved = reserved - :quantity
                where owner_id = :seller and market_key = :market and reserved >= :quantity
                """
            )
                .param("quantity", trade.quantity)
                .param("seller", seller.value)
                .param("market", trade.marketKey.value)
                .update()
            check(taken == 1) { "Seller of trade ${trade.resultId.value} has fewer reserved items than sold" }

            jdbc.sql(
                """
                insert into balances (owner_id, market_key, available) values (:buyer, :market, :quantity)
                on conflict (owner_id, market_key) do update set available = balances.available + excluded.available
                """
            )
                .param("buyer", buyer.value)
                .param("market", trade.marketKey.value)
                .param("quantity", trade.quantity)
                .update()
        }

        // Orders and the trade itself
        jdbc.sql("update orders set filled = filled + :quantity where order_id in (:ids)")
            .param("quantity", trade.quantity)
            .param("ids", listOf(buy.id, sell.id))
            .update()

        jdbc.sql(
            """
            insert into trades (trade_id, market_key, buy_order_id, sell_order_id, taker_side,
                                price, quantity, fee, asset_id, occurred_at)
            values (:tradeId, :market, :buy, :sell, :takerSide, :price, :quantity, :fee, :asset, :occurredAt)
            """
        )
            .param("tradeId", trade.resultId.value)
            .param("market", trade.marketKey.value)
            .param("buy", buy.id)
            .param("sell", sell.id)
            .param("takerSide", trade.takerSide.name)
            .param("price", trade.price.amount)
            .param("quantity", trade.quantity)
            .param("fee", fee)
            .param("asset", assetId?.value, java.sql.Types.BIGINT)
            .param("occurredAt", timestamp(trade.occurredAt))
            .update()

        notify(seller, "ITEM_SOLD") {
            put("marketKey", trade.marketKey.value)
            put("quantity", trade.quantity)
            put("price", trade.price.amount)
            put("proceeds", cost - fee)
        }
        notify(buyer, "ITEM_BOUGHT") {
            put("marketKey", trade.marketKey.value)
            put("quantity", trade.quantity)
            put("price", trade.price.amount)
        }

        marketEvents.tradeSettled(trade)
        val makerSide = if (trade.takerSide == Side.BUY) Side.SELL else Side.BUY
        marketEvents.levelChanged(trade.marketKey, makerSide, trade.price.amount, trade.occurredAt)
        trades.increment()
        tradedCredits.increment(cost.toDouble())
    }

    private fun openOrder(rested: OrderRested) {
        val order = lockOrder(rested.orderId)
        check(order.status == OrderStatus.PENDING) { "Order ${order.id} rested but is ${order.status} in core" }
        check(order.quantity - order.filled == rested.remainingQuantity) {
            "Order ${order.id}: ${order.quantity - order.filled} unfilled in core, ${rested.remainingQuantity} in the matcher"
        }

        jdbc.sql("update orders set status = 'OPEN' where order_id = :id")
            .param("id", order.id)
            .update()

        marketEvents.levelChanged(rested.marketKey, order.side, order.price, rested.occurredAt)
    }

    private fun closeOrder(closed: OrderClosed) {
        val order = lockOrder(closed.orderId)
        check(order.status != OrderStatus.CLOSED) { "Order ${order.id} is already closed in core" }
        check(order.quantity - order.filled == closed.remainingQuantity) {
            "Order ${order.id}: ${order.quantity - order.filled} unfilled in core, ${closed.remainingQuantity} in the matcher"
        }

        if (closed.remainingQuantity > 0) {
            releaseReservation(order, closed.remainingQuantity)
        }

        jdbc.sql("update orders set status = 'CLOSED', close_reason = :reason, closed_at = now() where order_id = :id")
            .param("reason", closed.reason.name)
            .param("id", order.id)
            .update()

        if (order.status == OrderStatus.OPEN) {
            marketEvents.levelChanged(closed.marketKey, order.side, order.price, closed.occurredAt)
        }
    }

    /** Gives back what the unfilled part of the order was holding. */
    private fun releaseReservation(order: OrderRow, remaining: Long) {
        val owner = UserId(order.ownerId)
        when {
            order.side == Side.BUY -> {
                val amount = Math.multiplyExact(order.price, remaining)
                ledger.post(
                    LedgerTxKind.RELEASE,
                    "order:${order.id}",
                    ledger.userAccount(owner, AccountKind.RESERVED) to -amount,
                    ledger.userAccount(owner, AccountKind.AVAILABLE) to amount,
                )
            }

            order.assetId != null -> {
                val released = jdbc.sql(
                    "update assets set state = 'AVAILABLE' where asset_id = :asset and owner_id = :owner and state = 'LISTED'"
                )
                    .param("asset", order.assetId)
                    .param("owner", owner.value)
                    .update()
                check(released == 1) { "Item ${order.assetId} of order ${order.id} is not listed" }
            }

            else -> {
                val released = jdbc.sql(
                    """
                    update balances set reserved = reserved - :quantity, available = available + :quantity
                    where owner_id = :owner and market_key = :market and reserved >= :quantity
                    """
                )
                    .param("quantity", remaining)
                    .param("owner", owner.value)
                    .param("market", order.marketKey)
                    .update()
                check(released == 1) { "Order ${order.id} holds fewer reserved items than its remainder" }
            }
        }
    }

    private fun lockOrder(id: OrderId) = lockOrders(listOf(id)).getValue(id)

    /** Locks the orders in order_id order, so that concurrent transactions cannot deadlock on them. */
    private fun lockOrders(ids: List<OrderId>): Map<OrderId, OrderRow> {
        val rows = jdbc.sql(
            """
            select order_id, market_key, owner_id, side, price, quantity, filled, asset_id, status
            from orders where order_id in (:ids)
            order by order_id
            for update
            """
        )
            .param("ids", ids.map { it.value })
            .query { rs, _ ->
                OrderRow(
                    id = rs.getLong("order_id"),
                    marketKey = rs.getString("market_key"),
                    ownerId = rs.getLong("owner_id"),
                    side = Side.valueOf(rs.getString("side")),
                    price = rs.getLong("price"),
                    quantity = rs.getLong("quantity"),
                    filled = rs.getLong("filled"),
                    assetId = (rs.getObject("asset_id") as Number?)?.toLong(),
                    status = OrderStatus.valueOf(rs.getString("status")),
                )
            }
            .list()
            .associateBy { OrderId(it.id) }
        ids.forEach { check(it in rows) { "Order ${it.value} from the matcher does not exist in core" } }
        return rows
    }

    private fun notify(user: UserId, kind: String, params: JsonObjectBuilder.() -> Unit) {
        jdbc.sql("insert into notifications (user_id, kind, params) values (:user, :kind, cast(:params as jsonb))")
            .param("user", user.value)
            .param("kind", kind)
            .param("params", buildJsonObject(params).toString())
            .update()
    }

    /** floor(cost × bps / 10000), computed without overflowing a Long even for the largest orders. */
    private fun feeOf(cost: Long): Long = cost / 10_000 * feeBps + cost % 10_000 * feeBps / 10_000

    private fun timestamp(epochMillis: Long): OffsetDateTime =
        OffsetDateTime.ofInstant(Instant.ofEpochMilli(epochMillis), ZoneOffset.UTC)

    private data class OrderRow(
        val id: Long,
        val marketKey: String,
        val ownerId: Long,
        val side: Side,
        val price: Long,
        val quantity: Long,
        val filled: Long,
        val assetId: Long?,
        val status: OrderStatus,
    )
}
