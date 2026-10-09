package space.davids_digital.giexchange.core.market

import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Component
import org.springframework.transaction.annotation.Propagation
import org.springframework.transaction.annotation.Transactional
import space.davids_digital.giexchange.contracts.BookLevelChanged
import space.davids_digital.giexchange.contracts.Credits
import space.davids_digital.giexchange.contracts.MarketKey
import space.davids_digital.giexchange.contracts.Side
import space.davids_digital.giexchange.contracts.TradeExecuted
import space.davids_digital.giexchange.contracts.TradeSettled
import space.davids_digital.giexchange.core.outbox.Outbox

/**
 * Publishes public market data through the outbox, in the same transaction as the change itself.
 * Every event takes the next sequence number of its market; the row lock on the market
 * makes sequence order equal to commit order.
 */
@Component
@Transactional(propagation = Propagation.MANDATORY)
class MarketEvents(private val jdbc: JdbcClient, private val outbox: Outbox) {

    fun tradeSettled(trade: TradeExecuted) {
        outbox.append(
            TradeSettled(
                marketKey = trade.marketKey,
                sequence = nextSequence(trade.marketKey),
                occurredAt = trade.occurredAt,
                tradeId = trade.resultId,
                price = trade.price,
                quantity = trade.quantity,
                takerSide = trade.takerSide,
                assetId = trade.assetId,
            )
        )
    }

    /** Publishes the current totals of one price level, computed from the open orders in the book. */
    fun levelChanged(marketKey: MarketKey, side: Side, price: Long, occurredAt: Long) {
        // A maker that a trade has just filled stays OPEN until its OrderClosed arrives right after;
        // it is no longer in the book, so it must not be counted.
        val (total, orders) = jdbc.sql(
            """
            select coalesce(sum(quantity - filled), 0) as total, count(*) as orders
            from orders
            where market_key = :market and side = :side and price = :price
              and status = 'OPEN' and filled < quantity
            """
        )
            .param("market", marketKey.value)
            .param("side", side.name)
            .param("price", price)
            .query { rs, _ -> rs.getLong("total") to rs.getInt("orders") }
            .single()

        outbox.append(
            BookLevelChanged(
                marketKey = marketKey,
                sequence = nextSequence(marketKey),
                occurredAt = occurredAt,
                side = side,
                price = Credits(price),
                totalQuantity = total,
                orderCount = orders,
            )
        )
    }

    private fun nextSequence(marketKey: MarketKey): Long =
        jdbc.sql("update markets set event_sequence = event_sequence + 1 where market_key = :market returning event_sequence")
            .param("market", marketKey.value)
            .query(Long::class.javaObjectType)
            .single()
}
