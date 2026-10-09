package space.davids_digital.giexchange.contracts

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * Public market data. Topic `market-events`, message key is [marketKey].
 * Written only by core (through the outbox) after the change is committed.
 * Read by realtime and price-history.
 *
 * Contains only what any visitor of the market page may see: no user ids.
 *
 * Every event of a market gets the next [sequence] number of that market, assigned in the same
 * transaction as the change itself, so sequence order is commit order. Readers use it to skip
 * duplicates (sequence not greater than the last processed one) and to detect gaps (a jump by more than one).
 *
 * Readers must skip event types they do not know instead of failing: the topic has several readers,
 * and adding a new event type must not require updating all of them at once.
 * Otherwise, the same evolution rules as for [OrderCommand] apply.
 */
@Serializable
sealed interface MarketEvent {
    val marketKey: MarketKey
    /** Per-market counter: 1, 2, 3, ... without gaps. */
    val sequence: Long
    /** Logical time of the match result behind this event. */
    val occurredAt: Long
}

/** A trade was settled: credits and the item have changed hands. */
@Serializable
@SerialName("trade")
data class TradeSettled(
    override val marketKey: MarketKey,
    override val sequence: Long,
    override val occurredAt: Long,
    val tradeId: MatchResultId,
    val price: Credits,
    val quantity: Long,
    /** Side of the incoming order. The trade feed colors trades by it. */
    val takerSide: Side,
    /** Set when a unique item changed hands. */
    val assetId: AssetId? = null,
) : MarketEvent {
    init {
        require(sequence > 0) { "Sequence must be positive: $sequence" }
        require(quantity > 0) { "Quantity must be positive: $quantity" }
        require(assetId == null || quantity == 1L) { "A unique item trade must have quantity 1" }
    }
}

/**
 * New state of one price level after a change. Carries totals, not a delta,
 * so applying the same event twice is harmless. Zero quantity means the level is gone.
 */
@Serializable
@SerialName("book-level")
data class BookLevelChanged(
    override val marketKey: MarketKey,
    override val sequence: Long,
    override val occurredAt: Long,
    val side: Side,
    val price: Credits,
    /** Total remaining quantity of all open orders on this side at this price. */
    val totalQuantity: Long,
    /** Number of open orders at this level. For unique items, the number of listings. */
    val orderCount: Int,
) : MarketEvent {
    init {
        require(sequence > 0) { "Sequence must be positive: $sequence" }
        require(totalQuantity >= 0) { "Total quantity must not be negative: $totalQuantity" }
        require(orderCount >= 0) { "Order count must not be negative: $orderCount" }
        require((totalQuantity == 0L) == (orderCount == 0)) {
            "A level is empty if and only if it has no orders"
        }
    }
}
