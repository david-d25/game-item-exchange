package space.davids_digital.giexchange.contracts

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * Matcher command. It is written to `orders` topic with [marketKey] message key.
 * Only Core writes, and only Matcher reads.
 *
 * New fields can be added, but existing fields must never be removed or changed so be backward-compatible.
 */
@Serializable
sealed interface OrderCommand {
    /** Unique command id; used for deduplication in the Matcher. */
    val commandId: CommandId
    val marketKey: MarketKey
    /** Epoch millis when Core accepted the order. */
    val issuedAt: Long
}

@Serializable
enum class TimeInForce {
    /** Good till canceled: the unfilled remainder rests in the book. */
    GTC,
    /** Immediate or cancel: fill what is possible now, cancel the remainder. */
    IOC,
    /** Fill or kill: fill the whole quantity now or nothing at all. */
    FOK,
}

/** Limit order: unfulfilled order parts stay in the order book until canceled. */
@Serializable
@SerialName("place")
data class PlaceOrder(
    override val commandId: CommandId,
    override val marketKey: MarketKey,
    override val issuedAt: Long,
    val orderId: OrderId,
    val ownerId: UserId,
    val side: Side,
    /** Limit price. */
    val price: Credits,
    val quantity: Long,
    /** Only for unique items. If set, quantity is always 1. */
    val assetId: AssetId? = null,
    val timeInForce: TimeInForce = TimeInForce.GTC,
) : OrderCommand {
    init {
        require(quantity > 0) { "Quantity must be positive: $quantity" }
        require(assetId == null || (side == Side.SELL && quantity == 1L)) {
            "assetId is allowed only for a sell order of quantity 1"
        }
    }
}

/** Cancel unfilled parts of order. */
@Serializable
@SerialName("cancel")
data class CancelOrder(
    override val commandId: CommandId,
    override val marketKey: MarketKey,
    override val issuedAt: Long,
    val orderId: OrderId,
) : OrderCommand

/**
 * «Buy this lot». Order with quantity 1 that is either filled immediately by [targetOrderId] or rejected
 * without being placed in the order book.
 */
@Serializable
@SerialName("take")
data class TakeListing(
    override val commandId: CommandId,
    override val marketKey: MarketKey,
    override val issuedAt: Long,
    val orderId: OrderId,
    val ownerId: UserId,
    val targetOrderId: OrderId,
    /** Lot price that the buyer saw and the exact amount of money reserved for this order. */
    val price: Credits,
) : OrderCommand
