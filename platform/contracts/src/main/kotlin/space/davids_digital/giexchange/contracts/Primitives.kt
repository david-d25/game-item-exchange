package space.davids_digital.giexchange.contracts

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

@JvmInline @Serializable value class UserId(val value: Long) {
    init {
        require(value > 0)
    }
}

@JvmInline @Serializable value class OrderId(val value: Long) {
    init {
        require(value > 0)
    }
}

@JvmInline @Serializable value class AssetId(val value: Long) {
    init {
        require(value > 0)
    }
}

@JvmInline @Serializable value class CommandId(val value: Long) {
    init {
        require(value > 0)
    }
}

/** Platform currency. Integer amount, no fractional units. */
@JvmInline
@Serializable
value class Credits(val amount: Long) : Comparable<Credits> {
    init {
        require(amount >= 0) { "Credits must be non-negative: $amount" }
    }

    override fun compareTo(other: Credits): Int = amount.compareTo(other.amount)
    operator fun times(quantity: Long) = Credits(Math.multiplyExact(amount, quantity))
    operator fun plus(other: Credits) = Credits(Math.addExact(amount, other.amount))
}


@Serializable
enum class Side { BUY, SELL }

/**
 * Market key: `game/def` or `game/def?attr=value&attr=value` with attributes sorted by name.
 *
 * The rules of building market key must never be changed, because they are used as Kafka message keys.
 */
@JvmInline
@Serializable
value class MarketKey(val value: String) {
    init {
        require(FORMAT.matches(value)) { "Malformed market key: $value" }
        val names = value.substringAfter('?', "").split('&').filter { it.isNotEmpty() }.map { it.substringBefore('=') }
        require(names.zipWithNext().all { (a, b) -> a < b }) { "Attributes must be sorted and unique: $value" }
    }

    companion object {
        private const val NAME = "[a-z0-9_-]+"
        private val FORMAT = Regex("^$NAME/$NAME(\\?$NAME=$NAME(&$NAME=$NAME)*)?$")

        /** Use this to build a market key. Attributes are guaranteed to be sorted by name. */
        fun of(gameId: String, defId: String, keyAttributes: Map<String, String> = emptyMap()): MarketKey {
            val base = "$gameId/$defId"
            if (keyAttributes.isEmpty()) return MarketKey(base)
            val query = keyAttributes.toSortedMap().entries.joinToString("&") { (k, v) -> "$k=$v" }
            return MarketKey("$base?$query")
        }
    }
}

/**
 * JSON settings for all Kafka messages.
 */
val ContractsJson: Json = Json {
    ignoreUnknownKeys = true
    encodeDefaults = true // Allows to read old messages in case default values change
    classDiscriminator = "type"
}
