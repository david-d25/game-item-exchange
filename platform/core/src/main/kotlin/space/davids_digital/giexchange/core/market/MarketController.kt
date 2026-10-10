package space.davids_digital.giexchange.core.market

import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.transaction.annotation.Isolation
import org.springframework.transaction.annotation.Transactional
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController
import space.davids_digital.giexchange.contracts.Side
import space.davids_digital.giexchange.core.api.invalidRequest
import space.davids_digital.giexchange.core.api.notFound
import java.sql.ResultSet
import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneOffset

data class MarketSummary(
    val marketId: Long,
    val marketKey: String,
    val gameId: String,
    val gameName: String,
    val defId: String,
    val name: String,
    val kind: String,
    val lastPrice: Long?,
    val open24h: Long?,
    val volume24h: Long,
    val trades24h: Long,
    val bestBid: Long?,
    val bestAsk: Long?,
)

data class BookLevel(val price: Long, val quantity: Long, val orders: Int)

data class BookResponse(
    val marketId: Long,
    val marketKey: String,
    /** Sequence of the last market event reflected in this snapshot: the event stream continues after it. */
    val sequence: Long,
    /** Cheapest first. */
    val asks: List<BookLevel>,
    /** Most expensive first. */
    val bids: List<BookLevel>,
)

data class PublicTrade(val tradeId: String, val price: Long, val quantity: Long, val takerSide: Side, val occurredAt: Instant)

data class Candle(
    val time: Instant,
    val open: Long,
    val high: Long,
    val low: Long,
    val close: Long,
    val volume: Long,
    val vwap: Double,
)

enum class CandleInterval(val key: String, val step: Duration) {
    ONE_MINUTE("1m", Duration.ofMinutes(1)),
    FIVE_MINUTES("5m", Duration.ofMinutes(5)),
    ONE_HOUR("1h", Duration.ofHours(1));

    /** The same length as a Postgres interval literal. */
    val sql: String get() = "${step.toSeconds()} seconds"

    companion object {
        fun parse(key: String): CandleInterval =
            entries.firstOrNull { it.key == key }
                ?: throw invalidRequest("interval must be one of ${entries.joinToString { it.key }}")
    }
}

/** Public market data: no user needed. */
@RestController
@RequestMapping("/api/v1/markets")
class MarketController(private val jdbc: JdbcClient, private val clock: Clock) {

    @GetMapping
    @Transactional(readOnly = true)
    fun list(): List<MarketSummary> = summaries(null)

    @GetMapping("/{marketId}")
    @Transactional(readOnly = true)
    fun get(@PathVariable marketId: Long): MarketSummary =
        summaries(marketId).firstOrNull() ?: throw notFound("Market $marketId")

    /**
     * All three queries run in one snapshot. With the default isolation every statement
     * sees its own moment, and the sequence number could disagree with the levels it is returned with,
     * which would break the gap detection in the browser.
     */
    @GetMapping("/{marketId}/book")
    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    fun book(@PathVariable marketId: Long, @RequestParam(defaultValue = "50") depth: Int): BookResponse {
        if (depth !in 1..MAX_DEPTH) {
            throw invalidRequest("depth must be between 1 and $MAX_DEPTH")
        }
        val (marketKey, sequence) = jdbc.sql("select market_key, event_sequence from markets where market_id = :id")
            .param("id", marketId)
            .query { rs, _ -> rs.getString("market_key") to rs.getLong("event_sequence") }
            .optional()
            .orElseThrow { notFound("Market $marketId") }

        return BookResponse(
            marketId = marketId,
            marketKey = marketKey,
            sequence = sequence,
            asks = levels(marketKey, Side.SELL, depth),
            bids = levels(marketKey, Side.BUY, depth),
        )
    }

    /** Latest trades, newest first. */
    @GetMapping("/{marketId}/trades")
    @Transactional(readOnly = true)
    fun trades(@PathVariable marketId: Long, @RequestParam(defaultValue = "50") limit: Int): List<PublicTrade> {
        if (limit !in 1..MAX_TRADES) {
            throw invalidRequest("limit must be between 1 and $MAX_TRADES")
        }
        val marketKey = marketKey(marketId)
        return jdbc.sql(
            """
            select trade_id, price, quantity, taker_side, occurred_at from trades
            where market_key = :market
            order by occurred_at desc, settled_at desc
            limit :limit
            """
        )
            .param("market", marketKey)
            .param("limit", limit)
            .query { rs, _ ->
                PublicTrade(
                    tradeId = rs.getString("trade_id"),
                    price = rs.getLong("price"),
                    quantity = rs.getLong("quantity"),
                    takerSide = Side.valueOf(rs.getString("taker_side")),
                    occurredAt = rs.instant("occurred_at"),
                )
            }
            .list()
    }

    /**
     * Candles of the last [limit] buckets, oldest first. Built from the one-minute candles
     * that settlement keeps, so the cost does not grow with the number of trades.
     */
    @GetMapping("/{marketId}/candles")
    @Transactional(readOnly = true)
    fun candles(
        @PathVariable marketId: Long,
        @RequestParam(defaultValue = "1m") interval: String,
        @RequestParam(defaultValue = "120") limit: Int,
    ): List<Candle> {
        val parsed = CandleInterval.parse(interval)
        if (limit !in 1..MAX_CANDLES) {
            throw invalidRequest("limit must be between 1 and $MAX_CANDLES")
        }
        val marketKey = marketKey(marketId)

        // The bucket that contains now, and limit - 1 buckets before it. Bucket edges are
        // whole multiples of the step since the Unix epoch, the same as date_bin from 2000-01-01.
        val step = parsed.step.toSeconds()
        val current = Math.floorDiv(clock.instant().epochSecond, step) * step
        val from = Instant.ofEpochSecond(current - step * (limit - 1))

        return jdbc.sql(
            """
            select date_bin(cast(:step as interval), bucket, timestamptz '${Candles.ORIGIN}') as time,
                   (array_agg(open order by bucket))[1] as open,
                   max(high) as high,
                   min(low) as low,
                   (array_agg(close order by bucket desc))[1] as close,
                   sum(volume) as volume,
                   sum(pv) / sum(volume) as vwap
            from candles_1m
            where market_key = :market and bucket >= :from
            group by 1
            order by 1
            """
        )
            .param("step", parsed.sql)
            .param("market", marketKey)
            .param("from", OffsetDateTime.ofInstant(from, ZoneOffset.UTC))
            .query { rs, _ ->
                Candle(
                    time = rs.instant("time"),
                    open = rs.getLong("open"),
                    high = rs.getLong("high"),
                    low = rs.getLong("low"),
                    close = rs.getLong("close"),
                    volume = rs.getLong("volume"),
                    vwap = rs.getBigDecimal("vwap").toDouble(),
                )
            }
            .list()
    }

    private fun summaries(marketId: Long?): List<MarketSummary> {
        val since = OffsetDateTime.ofInstant(clock.instant().minus(Duration.ofDays(1)), ZoneOffset.UTC)
        return jdbc.sql(
            """
            select m.market_id, m.market_key, m.game_id, g.name as game_name, m.def_id, d.name, d.kind,
                   (select c.close from candles_1m c
                    where c.market_key = m.market_key
                    order by c.bucket desc limit 1) as last_price,
                   day.open as open_24h,
                   coalesce(day.volume, 0) as volume_24h,
                   coalesce(day.trades, 0) as trades_24h,
                   (select max(o.price) from orders o
                    where o.market_key = m.market_key and o.side = 'BUY'
                      and o.status = 'OPEN' and o.filled < o.quantity) as best_bid,
                   (select min(o.price) from orders o
                    where o.market_key = m.market_key and o.side = 'SELL'
                      and o.status = 'OPEN' and o.filled < o.quantity) as best_ask
            from markets m
            join games g on g.game_id = m.game_id
            join item_definitions d on d.game_id = m.game_id and d.def_id = m.def_id
            left join lateral (
                select (array_agg(c.open order by c.bucket))[1] as open,
                       sum(c.volume) as volume,
                       sum(c.trades) as trades
                from candles_1m c
                where c.market_key = m.market_key and c.bucket >= :since
            ) day on true
            where cast(:marketId as bigint) is null or m.market_id = :marketId
            order by m.market_id
            """
        )
            .param("since", since)
            .param("marketId", marketId, java.sql.Types.BIGINT)
            .query { rs, _ ->
                MarketSummary(
                    marketId = rs.getLong("market_id"),
                    marketKey = rs.getString("market_key"),
                    gameId = rs.getString("game_id"),
                    gameName = rs.getString("game_name"),
                    defId = rs.getString("def_id"),
                    name = rs.getString("name"),
                    kind = rs.getString("kind"),
                    lastPrice = rs.longOrNull("last_price"),
                    open24h = rs.longOrNull("open_24h"),
                    volume24h = rs.getLong("volume_24h"),
                    trades24h = rs.getLong("trades_24h"),
                    bestBid = rs.longOrNull("best_bid"),
                    bestAsk = rs.longOrNull("best_ask"),
                )
            }
            .list()
    }

    private fun marketKey(marketId: Long): String =
        jdbc.sql("select market_key from markets where market_id = :id")
            .param("id", marketId)
            .query(String::class.java)
            .optional()
            .orElseThrow { notFound("Market $marketId") }

    private fun levels(marketKey: String, side: Side, depth: Int): List<BookLevel> {
        // Interpolated, not a parameter: SQL cannot take ORDER BY direction as a parameter.
        // Safe, because it is one of two constants and never comes from the request.
        val direction = if (side == Side.SELL) "asc" else "desc"
        return jdbc.sql(
            """
            select price, sum(quantity - filled) as quantity, count(*) as orders
            from orders
            where market_key = :market and side = :side and status = 'OPEN' and filled < quantity
            group by price
            order by price $direction
            limit :depth
            """
        )
            .param("market", marketKey)
            .param("side", side.name)
            .param("depth", depth)
            .query { rs, _ -> BookLevel(rs.getLong("price"), rs.getLong("quantity"), rs.getInt("orders")) }
            .list()
    }

    private fun ResultSet.instant(column: String): Instant =
        getObject(column, OffsetDateTime::class.java).toInstant()

    private fun ResultSet.longOrNull(column: String): Long? = (getObject(column) as Number?)?.toLong()

    private companion object {
        const val MAX_DEPTH = 500
        const val MAX_TRADES = 200
        const val MAX_CANDLES = 500
    }
}
