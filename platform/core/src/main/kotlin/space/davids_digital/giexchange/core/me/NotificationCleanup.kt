package space.davids_digital.giexchange.core.me

import org.slf4j.LoggerFactory
import org.springframework.beans.factory.annotation.Value
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.scheduling.annotation.Scheduled
import org.springframework.stereotype.Component
import java.time.Duration

/**
 * Deletes old notifications: the interface shows only the latest few, and on a public demo
 * thousands of guests come once and never return. Running it on several replicas at once is harmless.
 */
@Component
class NotificationCleanup(
    private val jdbc: JdbcClient,
    @Value($$"${giexchange.notifications.keep:7d}") private val keep: Duration,
) {
    private val log = LoggerFactory.getLogger(javaClass)

    @Scheduled(initialDelay = 1, fixedDelay = 60, timeUnit = java.util.concurrent.TimeUnit.MINUTES)
    fun deleteOld() {
        val deleted = jdbc.sql("delete from notifications where created_at < now() - cast(:keep as interval)")
            .param("keep", "${keep.toSeconds()} seconds")
            .update()
        if (deleted > 0) {
            log.info("Deleted {} notifications older than {}", deleted, keep)
        }
    }
}
