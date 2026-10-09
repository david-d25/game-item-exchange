package space.davids_digital.giexchange.core.settlement

import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.kafka.listener.CommonErrorHandler
import org.springframework.kafka.listener.DefaultErrorHandler
import org.springframework.util.backoff.FixedBackOff

@Configuration
class KafkaConfig {
    /**
     * By default, Spring Kafka retries a failed record a few times and then skips it with a log line.
     * For match results that means silently losing money or items. Here a failed result is retried
     * every five seconds forever: the partition stops, which is loud and visible as growing consumer lag,
     * and it resumes by itself once the cause is fixed.
     */
    @Bean
    fun kafkaErrorHandler(): CommonErrorHandler =
        DefaultErrorHandler(FixedBackOff(5_000L, FixedBackOff.UNLIMITED_ATTEMPTS))
}
