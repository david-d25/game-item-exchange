package space.davids_digital.giexchange.contracts

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * ID of a [MatchResult]: `commandId-index`, where index is the position of the result
 * among all results produced by that command. Deterministic, so core can deduplicate
 * results the matcher emits again after a replay.
 */
@JvmInline
@Serializable
value class MatchResultId(val value: String) {
    constructor(commandId: CommandId, index: Int) : this("${commandId.value}-$index")

    init {
        require(FORMAT.matches(value)) { "Malformed match result id: $value" }
    }

    companion object {
        private const val NUMBER = "(0|[1-9][0-9]*)"
        private val FORMAT = Regex("^$NUMBER-$NUMBER$")
    }
}

/**
 * Result of order matching. Topic `match-results`, message key is [marketKey].
 * Written only by matcher, read only by core.
 *
 * Results of one command are published together, in this order:
 * - place, take: zero or more [TradeExecuted], each immediately followed by [OrderClosed]
 *   with [CloseReason.FILLED] if it completely filled the resting (maker) order,
 *   then exactly one terminal result for the command's own order: [OrderRested] or [OrderClosed];
 * - cancel: exactly one [OrderClosed] with [CloseReason.CANCELED] or [CancelRejected];
 * - duplicate command: no results.
 *
 * Core relies on this order: the terminal result means the command is fully processed,
 * and all trades of an order are settled before the order is closed.
 * The same evolution rules as for [OrderCommand] apply.
 */
@Serializable
sealed interface MatchResult {
    val resultId: MatchResultId
    /** The command that caused this result. */
    val commandId: CommandId
    val marketKey: MarketKey
    /** Logical time: [OrderCommand.issuedAt] of the command. The matcher never reads the system clock. */
    val occurredAt: Long
}


@Serializable
@SerialName("trade")
data class TradeExecuted(
    override val resultId: MatchResultId,
    override val commandId: CommandId,
    override val marketKey: MarketKey,
    override val occurredAt: Long,
    val buyOrderId: OrderId,
    val sellOrderId: OrderId,
    val buyerId: UserId,
    val sellerId: UserId,
    /** Side of the incoming order. The other side was resting in the book and set the price. */
    val takerSide: Side,
    /** Price of the resting (maker) order. */
    val price: Credits,
    val quantity: Long,
    /** Set when a unique item changes hands. */
    val assetId: AssetId? = null,
) : MatchResult {
    init {
        require(quantity > 0) { "Quantity must be positive: $quantity" }
        require(assetId == null || quantity == 1L) { "A unique item trade must have quantity 1" }
    }
}

/** The unfilled remainder of a GTC order was placed in the book. */
@Serializable
@SerialName("rested")
data class OrderRested(
    override val resultId: MatchResultId,
    override val commandId: CommandId,
    override val marketKey: MarketKey,
    override val occurredAt: Long,
    val orderId: OrderId,
    /** Quantity left in the book after the trades executed by this command. */
    val remainingQuantity: Long,
) : MatchResult {
    init {
        require(remainingQuantity > 0) { "A resting order must have a positive remainder: $remainingQuantity" }
    }
}

@Serializable
enum class CloseReason {
    /** Completely filled. */
    FILLED,
    /** Canceled by a [CancelOrder] command. */
    CANCELED,
    /** IOC order: the part that could not be filled immediately. */
    IOC_UNFILLED,
    /** FOK order: not enough volume to fill it completely, so no trades were executed. */
    FOK_UNFILLED,
    /** Take: the target order is no longer in the book. */
    TARGET_UNAVAILABLE,
    /** Take: the target order's price differs from the price the buyer saw. */
    TARGET_PRICE_MISMATCH,
}

/** The order is finished and will never trade again. */
@Serializable
@SerialName("closed")
data class OrderClosed(
    override val resultId: MatchResultId,
    override val commandId: CommandId,
    override val marketKey: MarketKey,
    override val occurredAt: Long,
    val orderId: OrderId,
    val reason: CloseReason,
    /** Unfilled quantity: core releases the reservation for it. Zero if and only if [reason] is FILLED. */
    val remainingQuantity: Long,
) : MatchResult {
    init {
        require(remainingQuantity >= 0) { "Remaining quantity must not be negative: $remainingQuantity" }
        require((reason == CloseReason.FILLED) == (remainingQuantity == 0L)) {
            "Remaining quantity is zero if and only if the order is filled"
        }
    }
}

/** The order to cancel was not in the book: already filled, already canceled or never rested. */
@Serializable
@SerialName("cancel-rejected")
data class CancelRejected(
    override val resultId: MatchResultId,
    override val commandId: CommandId,
    override val marketKey: MarketKey,
    override val occurredAt: Long,
    val orderId: OrderId,
) : MatchResult

