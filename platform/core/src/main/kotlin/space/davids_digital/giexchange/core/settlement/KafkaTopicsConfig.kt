package space.davids_digital.giexchange.core.settlement

import org.apache.kafka.clients.admin.NewTopic
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.kafka.config.TopicBuilder
import org.springframework.kafka.core.KafkaAdmin
import space.davids_digital.giexchange.contracts.Topics

/**
 * Creates the platform topics at startup where nothing else does. In Kubernetes the Strimzi topic
 * operator owns them (deploy/infra/kafka/topics.yaml); in the Compose production there is no operator,
 * so core creates them, with the same settings. Existing topics are left as they are.
 */
@Configuration
@ConditionalOnProperty("giexchange.topics.create", havingValue = "true")
class KafkaTopicsConfig {

    @Bean
    fun platformTopics(): KafkaAdmin.NewTopics = KafkaAdmin.NewTopics(
        topic(Topics.ORDERS),
        topic(Topics.MATCH_RESULTS),
        topic(Topics.MARKET_EVENTS),
    )

    // Partition count is fixed forever: the partition of a market is computed from it.
    // Retention is unlimited: the matcher rebuilds order books by replaying `orders` from the beginning.
    private fun topic(name: String): NewTopic =
        TopicBuilder.name(name)
            .partitions(PARTITIONS)
            .replicas(1)
            .config("retention.ms", "-1")
            .build()

    private companion object {
        const val PARTITIONS = 12
    }
}
