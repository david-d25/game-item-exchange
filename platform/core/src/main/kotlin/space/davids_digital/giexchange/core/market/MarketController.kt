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

@RestController
@RequestMapping("/api/v1/markets")
class MarketController(private val jdbc: JdbcClient) {

    /**
     * Public: no user needed. All three queries run in one snapshot. With the default isolation every statement
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

    private companion object {
        const val MAX_DEPTH = 500
    }
}
