package space.davids_digital.giexchange.matcher

import com.sun.net.httpserver.HttpServer
import io.micrometer.core.instrument.Gauge
import io.micrometer.core.instrument.MeterRegistry
import io.micrometer.core.instrument.Timer
import io.micrometer.core.instrument.binder.jvm.JvmGcMetrics
import io.micrometer.core.instrument.binder.jvm.JvmMemoryMetrics
import io.micrometer.core.instrument.binder.jvm.JvmThreadMetrics
import io.micrometer.core.instrument.binder.kafka.KafkaClientMetrics
import io.micrometer.core.instrument.binder.system.ProcessorMetrics
import io.micrometer.prometheusmetrics.PrometheusConfig
import io.micrometer.prometheusmetrics.PrometheusMeterRegistry
import org.apache.kafka.clients.consumer.ConsumerConfig
import org.apache.kafka.clients.consumer.ConsumerRebalanceListener
import org.apache.kafka.clients.consumer.ConsumerRecords
import org.apache.kafka.clients.consumer.KafkaConsumer
import org.apache.kafka.clients.consumer.OffsetAndMetadata
import org.apache.kafka.clients.producer.KafkaProducer
import org.apache.kafka.clients.producer.ProducerConfig
import org.apache.kafka.clients.producer.ProducerRecord
import org.apache.kafka.clients.producer.RecordMetadata
import org.apache.kafka.common.TopicPartition
import org.apache.kafka.common.errors.WakeupException
import org.apache.kafka.common.serialization.StringDeserializer
import org.apache.kafka.common.serialization.StringSerializer
import org.slf4j.LoggerFactory
import space.davids_digital.giexchange.contracts.CancelOrder
import space.davids_digital.giexchange.contracts.ContractsJson
import space.davids_digital.giexchange.contracts.MatchResult
import space.davids_digital.giexchange.contracts.OrderCommand
import space.davids_digital.giexchange.contracts.PlaceOrder
import space.davids_digital.giexchange.contracts.TakeListing
import space.davids_digital.giexchange.contracts.Topics
import space.davids_digital.giexchange.contracts.TradeExecuted
import java.net.InetSocketAddress
import java.time.Duration
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Future

fun main() {
    val bootstrapServers = System.getenv("KAFKA_BOOTSTRAP_SERVERS") ?: "localhost:9092"
    val metricsPort = System.getenv("METRICS_PORT")?.toInt() ?: 9404

    val registry = PrometheusMeterRegistry(PrometheusConfig.DEFAULT)
    registry.config().commonTags("application", "matcher")
    JvmMemoryMetrics().bindTo(registry)
    JvmGcMetrics().bindTo(registry)
    JvmThreadMetrics().bindTo(registry)
    ProcessorMetrics().bindTo(registry)
    val metricsServer = startMetricsServer(registry, metricsPort)

    val matcher = Matcher(bootstrapServers, registry)

    // On SIGTERM (e.g. from Kubernetes) interrupt poll() and wait until run() has closed the clients
    val mainThread = Thread.currentThread()
    Runtime.getRuntime().addShutdownHook(Thread {
        matcher.wakeup()
        mainThread.join()
        metricsServer.stop(0)
    })

    matcher.run()
}

/** Serves metrics in the Prometheus text format on /metrics, using the HTTP server built into the JDK. */
private fun startMetricsServer(registry: PrometheusMeterRegistry, port: Int): HttpServer {
    val server = HttpServer.create(InetSocketAddress(port), 0)
    server.createContext("/metrics") { exchange ->
        val body = registry.scrape().toByteArray()
        exchange.responseHeaders.add("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
        exchange.sendResponseHeaders(200, body.size.toLong())
        exchange.responseBody.use { it.write(body) }
    }
    server.start()
    return server
}

/**
 * Reads commands from `orders`, applies them to in-memory order books and publishes results to `match-results`.
 *
 * Order books live only in memory. When this process gets a partition, it replays the partition from the
 * beginning to rebuild them. Results of commands before the committed offset were already published by the
 * previous owner, so during that part of the replay nothing is published.
 *
 * Any unexpected error stops the process. After a restart the replay restores exactly the same state,
 * and results published twice have the same ids, so core drops the duplicates.
 */
class Matcher(bootstrapServers: String, private val registry: MeterRegistry) {
    private val log = LoggerFactory.getLogger(javaClass)

    private val consumer = KafkaConsumer<String, String>(
        mapOf<String, Any>(
            ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG to bootstrapServers,
            ConsumerConfig.GROUP_ID_CONFIG to "matcher",
            // Incremental rebalancing: partitions that stay with this instance keep their order books
            ConsumerConfig.GROUP_PROTOCOL_CONFIG to "consumer",
            ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG to false,
            ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG to StringDeserializer::class.java,
            ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG to StringDeserializer::class.java,
        )
    )

    private val producer = KafkaProducer<String, String>(
        mapOf<String, Any>(
            ProducerConfig.BOOTSTRAP_SERVERS_CONFIG to bootstrapServers,
            ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG to StringSerializer::class.java,
            ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG to StringSerializer::class.java,
            // Both are defaults in modern clients. Stated explicitly because result ordering depends on them.
            ProducerConfig.ACKS_CONFIG to "all",
            ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG to true,
        )
    )

    /** State of each partition this process owns: its own books, independent of all other partitions. */
    private class PartitionState(val publishFrom: Long) {
        val engine = MatchingEngine()

        // Read by the metrics thread, written by the polling thread
        @Volatile
        var replaying: Boolean = publishFrom > 0
    }

    // Concurrent: the metrics thread reads it while the polling thread changes it
    private val partitions = ConcurrentHashMap<Int, PartitionState>()

    private val batchTimer = Timer.builder("matcher.batch")
        .description("Time to apply one batch of commands and publish its results")
        .publishPercentileHistogram()
        .register(registry)

    init {
        Gauge.builder("matcher.partitions", partitions) { it.size.toDouble() }
            .description("Partitions of orders owned by this instance")
            .register(registry)
        Gauge.builder("matcher.partitions.replaying", partitions) { states -> states.values.count { it.replaying }.toDouble() }
            .description("Owned partitions still being replayed to rebuild their order books")
            .register(registry)
        KafkaClientMetrics(consumer).bindTo(registry)
        KafkaClientMetrics(producer).bindTo(registry)
    }

    private val rebalanceListener = object : ConsumerRebalanceListener {
        override fun onPartitionsAssigned(assigned: Collection<TopicPartition>) {
            if (assigned.isEmpty()) return
            val committed = consumer.committed(assigned.toSet())
            for (partition in assigned) {
                val publishFrom = committed[partition]?.offset() ?: 0L
                partitions[partition.partition()] = PartitionState(publishFrom)
                log.info("Partition {} assigned: replaying from the beginning, publishing from offset {}",
                    partition.partition(), publishFrom)
            }
            consumer.seekToBeginning(assigned)
        }

        override fun onPartitionsRevoked(revoked: Collection<TopicPartition>) {
            revoked.forEach { partitions.remove(it.partition()) }
        }
    }

    fun wakeup() = consumer.wakeup()

    fun run() {
        consumer.subscribe(listOf(Topics.ORDERS), rebalanceListener)
        try {
            while (true) {
                val records = consumer.poll(Duration.ofMillis(500))
                if (!records.isEmpty) {
                    val sample = Timer.start(registry)
                    process(records)
                    sample.stop(batchTimer)
                }
            }
        } catch (_: WakeupException) {
            log.info("Shutting down")
        } finally {
            consumer.close()
            producer.close()
        }
    }

    private fun process(records: ConsumerRecords<String, String>) {
        val sends = mutableListOf<Future<RecordMetadata>>()
        val offsets = HashMap<TopicPartition, OffsetAndMetadata>()

        for (record in records) {
            val state = partitions.getValue(record.partition())
            val command = ContractsJson.decodeFromString<OrderCommand>(record.value())
            val results = state.engine.apply(command)
            val live = record.offset() >= state.publishFrom
            state.replaying = record.offset() + 1 < state.publishFrom

            registry.counter("matcher.commands", "type", command.typeName(), "phase", if (live) "live" else "replay")
                .increment()

            if (live) {
                for (result in results) {
                    val payload = ContractsJson.encodeToString<MatchResult>(result)
                    sends += producer.send(ProducerRecord(Topics.MATCH_RESULTS, result.marketKey.value, payload))
                }
                registry.counter("matcher.trades").increment(results.count { it is TradeExecuted }.toDouble())
                offsets[TopicPartition(record.topic(), record.partition())] = OffsetAndMetadata(record.offset() + 1)
            }
        }

        // Results first, offsets second: a crash in between means publishing again, never losing results
        sends.forEach { it.get() }
        if (offsets.isNotEmpty()) {
            consumer.commitSync(offsets)
        }
    }
}

private fun OrderCommand.typeName(): String = when (this) {
    is PlaceOrder -> "place"
    is CancelOrder -> "cancel"
    is TakeListing -> "take"
}
