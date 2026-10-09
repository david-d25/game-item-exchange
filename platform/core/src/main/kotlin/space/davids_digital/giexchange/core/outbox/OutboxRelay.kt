package space.davids_digital.giexchange.core.outbox

import org.slf4j.LoggerFactory
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.kafka.core.KafkaTemplate
import org.springframework.scheduling.annotation.Scheduled
import org.springframework.stereotype.Component
import org.springframework.transaction.PlatformTransactionManager
import org.springframework.transaction.support.TransactionTemplate
import java.util.concurrent.TimeUnit

/**
 * Publishes outbox messages to Kafka in outbox_id order and marks them as sent.
 *
 * Delivery is at least once: if the process dies after Kafka accepted a batch but before the batch
 * is marked as sent, the batch is sent again, and readers drop the duplicates.
 *
 * Must run as a single instance, otherwise messages of one market may be reordered.
 * Deployment guarantees that; the advisory lock below is a safety net for when it does not.
 */
@Component
@ConditionalOnProperty("giexchange.relay.enabled", havingValue = "true")
class OutboxRelay(
    private val jdbc: JdbcClient,
    private val kafka: KafkaTemplate<String, String>,
    transactionManager: PlatformTransactionManager,
) {
    private val log = LoggerFactory.getLogger(javaClass)

    // Programmatic transactions: @Transactional on a method called from this same class
    // would be silently ignored, because the call does not go through the Spring proxy.
    private val transactions = TransactionTemplate(transactionManager)

    @Scheduled(fixedDelayString = $$"${giexchange.relay.poll-interval:200ms}")
    fun poll() {
        try {
            // A full batch means there may be more: drain the backlog without waiting for the next tick
            while (relayBatch() == BATCH_SIZE) {
                continue
            }
        } catch (e: Exception) {
            log.warn("Outbox relay failed, the batch will be retried: {}", e.message)
        }
    }

    @Scheduled(fixedDelay = 1, timeUnit = TimeUnit.HOURS)
    fun deleteSentMessages() {
        val deleted = jdbc.sql("delete from outbox where sent_at < now() - interval '1 day'").update()
        if (deleted > 0) {
            log.info("Deleted {} sent outbox messages", deleted)
        }
    }

    /** Sends one batch inside one database transaction. Returns the number of messages sent. */
    private fun relayBatch(): Int = transactions.execute {
        // Held until the transaction ends: two relays never send batches at the same time
        val locked = jdbc.sql("select pg_try_advisory_xact_lock(:key)")
            .param("key", LOCK_KEY)
            .query(Boolean::class.javaObjectType)
            .single()
        if (!locked) {
            return@execute 0
        }

        val batch = jdbc.sql(
            """
            select outbox_id, topic, message_key, payload from outbox
            where sent_at is null
            order by outbox_id
            limit :limit
            """
        )
            .param("limit", BATCH_SIZE)
            .query { rs, _ ->
                OutboxMessage(
                    rs.getLong("outbox_id"),
                    rs.getString("topic"),
                    rs.getString("message_key"),
                    rs.getString("payload")
                )
            }
            .list()
        if (batch.isEmpty()) {
            return@execute 0
        }

        // Sent in outbox_id order; the idempotent producer keeps that order within each partition, even on retries
        val sends = batch.map { kafka.send(it.topic, it.key, it.payload) }
        sends.forEach { it.get(SEND_TIMEOUT_SECONDS, TimeUnit.SECONDS) }

        jdbc.sql("update outbox set sent_at = now() where outbox_id in (:ids)")
            .param("ids", batch.map { it.id })
            .update()
        batch.size
    }

    private data class OutboxMessage(val id: Long, val topic: String, val key: String, val payload: String)

    private companion object {
        const val BATCH_SIZE = 100
        const val SEND_TIMEOUT_SECONDS = 10L
        // Any number unique among the application's advisory locks
        const val LOCK_KEY = 4_101_001L
    }
}
