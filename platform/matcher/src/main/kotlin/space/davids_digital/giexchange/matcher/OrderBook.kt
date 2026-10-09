package space.davids_digital.giexchange.matcher

import space.davids_digital.giexchange.contracts.AssetId
import space.davids_digital.giexchange.contracts.CancelOrder
import space.davids_digital.giexchange.contracts.CancelRejected
import space.davids_digital.giexchange.contracts.CloseReason
import space.davids_digital.giexchange.contracts.Credits
import space.davids_digital.giexchange.contracts.MatchResult
import space.davids_digital.giexchange.contracts.MatchResultId
import space.davids_digital.giexchange.contracts.OrderClosed
import space.davids_digital.giexchange.contracts.OrderCommand
import space.davids_digital.giexchange.contracts.OrderId
import space.davids_digital.giexchange.contracts.OrderRested
import space.davids_digital.giexchange.contracts.PlaceOrder
import space.davids_digital.giexchange.contracts.Side
import space.davids_digital.giexchange.contracts.TakeListing
import space.davids_digital.giexchange.contracts.TimeInForce
import space.davids_digital.giexchange.contracts.TradeExecuted
import space.davids_digital.giexchange.contracts.UserId
import java.util.TreeMap

/** An order resting in the book, or the incoming order being matched. Exists only inside the matcher. */
internal class BookOrder(
    val id: OrderId,
    val ownerId: UserId,
    val side: Side,
    val price: Long,
    var remaining: Long,
    val assetId: AssetId?,
)

/** Collects the results of one command and numbers them: `commandId-index`, in the order they are produced. */
internal class Results(private val command: OrderCommand) {
    private val list = mutableListOf<MatchResult>()

    fun toList(): List<MatchResult> = list

    private fun nextId() = MatchResultId(command.commandId, list.size)

    fun trade(taker: BookOrder, maker: BookOrder, quantity: Long) {
        val (buy, sell) = if (taker.side == Side.BUY) taker to maker else maker to taker
        list += TradeExecuted(
            resultId = nextId(),
            commandId = command.commandId,
            marketKey = command.marketKey,
            occurredAt = command.issuedAt,
            buyOrderId = buy.id,
            sellOrderId = sell.id,
            buyerId = buy.ownerId,
            sellerId = sell.ownerId,
            takerSide = taker.side,
            price = Credits(maker.price),
            quantity = quantity,
            assetId = sell.assetId,
        )
    }

    fun rested(order: BookOrder) {
        list += OrderRested(
            resultId = nextId(),
            commandId = command.commandId,
            marketKey = command.marketKey,
            occurredAt = command.issuedAt,
            orderId = order.id,
            remainingQuantity = order.remaining,
        )
    }

    fun closed(orderId: OrderId, reason: CloseReason, remaining: Long) {
        list += OrderClosed(
            resultId = nextId(),
            commandId = command.commandId,
            marketKey = command.marketKey,
            occurredAt = command.issuedAt,
            orderId = orderId,
            reason = reason,
            remainingQuantity = remaining,
        )
    }

    fun cancelRejected(orderId: OrderId) {
        list += CancelRejected(
            resultId = nextId(),
            commandId = command.commandId,
            marketKey = command.marketKey,
            occurredAt = command.issuedAt,
            orderId = orderId,
        )
    }
}

/**
 * Order book of one market. Single-threaded and deterministic: the same commands in the same order
 * always produce the same results. Recovery by replay depends on that, so no clocks, no randomness,
 * and no iteration over unordered collections when producing results.
 */
internal class OrderBook {
    // Price → orders at that price in arrival order. Each side is sorted so that its best price comes first.
    private val asks = TreeMap<Long, ArrayDeque<BookOrder>>()
    private val bids = TreeMap<Long, ArrayDeque<BookOrder>>(Comparator.reverseOrder())
    private val byId = HashMap<OrderId, BookOrder>()

    fun place(command: PlaceOrder, results: Results) {
        val taker = BookOrder(
            id = command.orderId,
            ownerId = command.ownerId,
            side = command.side,
            price = command.price.amount,
            remaining = command.quantity,
            assetId = command.assetId,
        )
        if (command.timeInForce == TimeInForce.FOK && availableVolume(taker) < taker.remaining) {
            results.closed(taker.id, CloseReason.FOK_UNFILLED, taker.remaining)
            return
        }

        match(taker, results)

        when {
            taker.remaining == 0L -> results.closed(taker.id, CloseReason.FILLED, 0)
            command.timeInForce == TimeInForce.GTC -> {
                rest(taker)
                results.rested(taker)
            }
            else -> results.closed(taker.id, CloseReason.IOC_UNFILLED, taker.remaining)
        }
    }

    fun take(command: TakeListing, results: Results) {
        val target = byId[command.targetOrderId]
        when {
            target == null || target.side != Side.SELL ->
                results.closed(command.orderId, CloseReason.TARGET_UNAVAILABLE, 1)

            target.price != command.price.amount ->
                results.closed(command.orderId, CloseReason.TARGET_PRICE_MISMATCH, 1)

            else -> {
                val taker = BookOrder(command.orderId, command.ownerId, Side.BUY, command.price.amount, 1, null)
                results.trade(taker, target, 1)
                target.remaining -= 1
                if (target.remaining == 0L) {
                    remove(target)
                    results.closed(target.id, CloseReason.FILLED, 0)
                }
                results.closed(taker.id, CloseReason.FILLED, 0)
            }
        }
    }

    fun cancel(command: CancelOrder, results: Results) {
        val order = byId[command.orderId]
        if (order == null) {
            results.cancelRejected(command.orderId)
            return
        }
        remove(order)
        results.closed(order.id, CloseReason.CANCELED, order.remaining)
    }

    /** Takes the best opposite orders one by one while their price suits the taker. */
    private fun match(taker: BookOrder, results: Results) {
        val opposite = oppositeOf(taker.side)
        while (taker.remaining > 0) {
            val level = opposite.firstEntry() ?: break
            if (!suits(taker, level.key)) break
            val maker = level.value.first()
            val quantity = minOf(taker.remaining, maker.remaining)

            results.trade(taker, maker, quantity)
            taker.remaining -= quantity
            maker.remaining -= quantity

            if (maker.remaining == 0L) {
                level.value.removeFirst()
                byId.remove(maker.id)
                if (level.value.isEmpty()) opposite.remove(level.key)
                results.closed(maker.id, CloseReason.FILLED, 0)
            }
        }
    }

    /** Opposite volume the taker could trade right now; stops counting as soon as it is enough. */
    private fun availableVolume(taker: BookOrder): Long {
        var volume = 0L
        for ((price, orders) in oppositeOf(taker.side)) {
            if (!suits(taker, price)) break
            for (order in orders) {
                volume += order.remaining
                if (volume >= taker.remaining) return volume
            }
        }
        return volume
    }

    private fun rest(order: BookOrder) {
        sideOf(order.side).getOrPut(order.price) { ArrayDeque() }.addLast(order)
        byId[order.id] = order
    }

    private fun remove(order: BookOrder) {
        val side = sideOf(order.side)
        val level = side.getValue(order.price)
        level.remove(order)
        if (level.isEmpty()) side.remove(order.price)
        byId.remove(order.id)
    }

    /** Whether a resting order at this price is good enough for the taker. */
    private fun suits(taker: BookOrder, price: Long) =
        if (taker.side == Side.BUY) price <= taker.price else price >= taker.price

    private fun sideOf(side: Side) = if (side == Side.BUY) bids else asks

    private fun oppositeOf(side: Side) = if (side == Side.BUY) asks else bids
}
