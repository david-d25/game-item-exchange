package space.davids_digital.giexchange.matcher

import space.davids_digital.giexchange.contracts.CancelOrder
import space.davids_digital.giexchange.contracts.CommandId
import space.davids_digital.giexchange.contracts.MarketKey
import space.davids_digital.giexchange.contracts.MatchResult
import space.davids_digital.giexchange.contracts.OrderCommand
import space.davids_digital.giexchange.contracts.PlaceOrder
import space.davids_digital.giexchange.contracts.TakeListing

/**
 * All order books of one partition of `orders`, plus the commands already processed.
 * Knows nothing about Kafka: commands in, results out, so it is fully testable with plain unit tests.
 */
class MatchingEngine {
    private val books = HashMap<MarketKey, OrderBook>()

    // Grows without bound for now. Later it can keep only a time window by issuedAt:
    // duplicates from the relay arrive within seconds, not days.
    private val seenCommands = HashSet<CommandId>()

    fun apply(command: OrderCommand): List<MatchResult> {
        if (!seenCommands.add(command.commandId)) {
            return emptyList()
        }
        val book = books.getOrPut(command.marketKey) { OrderBook() }
        val results = Results(command)
        when (command) {
            is PlaceOrder -> book.place(command, results)
            is TakeListing -> book.take(command, results)
            is CancelOrder -> book.cancel(command, results)
        }
        return results.toList()
    }
}
