package space.davids_digital.giexchange.core.outbox

import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Component
import org.springframework.transaction.annotation.Propagation
import org.springframework.transaction.annotation.Transactional
import space.davids_digital.giexchange.contracts.ContractsJson
import space.davids_digital.giexchange.contracts.MarketEvent
import space.davids_digital.giexchange.contracts.OrderCommand
import space.davids_digital.giexchange.contracts.Topics

/**
 * Messages waiting to be published to Kafka by the relay.
 * Never opens a transaction of its own: a message is stored together with the change it describes, or not at all.
 */
@Component
@Transactional(propagation = Propagation.MANDATORY)
class Outbox(private val jdbc: JdbcClient) {

    fun append(command: OrderCommand) =
        // Serialized as OrderCommand, not as its concrete class: otherwise the "type" field is missing
        append(Topics.ORDERS, command.marketKey.value, ContractsJson.encodeToString<OrderCommand>(command))

    fun append(event: MarketEvent) =
        append(Topics.MARKET_EVENTS, event.marketKey.value, ContractsJson.encodeToString<MarketEvent>(event))

    private fun append(topic: String, key: String, payload: String) {
        jdbc.sql("insert into outbox (topic, message_key, payload) values (:topic, :key, :payload)")
            .param("topic", topic)
            .param("key", key)
            .param("payload", payload)
            .update()
    }
}
