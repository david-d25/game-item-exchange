package space.davids_digital.giexchange.core.market

import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Component
import org.springframework.transaction.annotation.Propagation
import org.springframework.transaction.annotation.Transactional
import java.time.OffsetDateTime

/**
 * Keeps the one-minute candles of each market up to date, in the same transaction as the trade.
 * Results of one market arrive in order (one partition), so the latest trade of a minute is its close.
 */
@Component
@Transactional(propagation = Propagation.MANDATORY)
class Candles(private val jdbc: JdbcClient) {

    fun record(marketKey: String, price: Long, quantity: Long, occurredAt: OffsetDateTime) {
        jdbc.sql(
            """
            insert into candles_1m (market_key, bucket, open, high, low, close, volume, pv, trades)
            values (:market, date_bin('1 minute', :occurredAt, timestamptz '$ORIGIN'),
                    :price, :price, :price, :price, :quantity, cast(:price as numeric) * :quantity, 1)
            on conflict (market_key, bucket) do update set
                high = greatest(candles_1m.high, excluded.high),
                low = least(candles_1m.low, excluded.low),
                close = excluded.close,
                volume = candles_1m.volume + excluded.volume,
                pv = candles_1m.pv + excluded.pv,
                trades = candles_1m.trades + 1
            """
        )
            .param("market", marketKey)
            .param("occurredAt", occurredAt)
            .param("price", price)
            .param("quantity", quantity)
            .update()
    }

    companion object {
        /** Buckets of every length start at this moment: whole minutes and hours in UTC. */
        const val ORIGIN = "2000-01-01 00:00:00+00"
    }
}
