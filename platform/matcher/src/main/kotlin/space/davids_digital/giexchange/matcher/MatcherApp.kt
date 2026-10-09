package space.davids_digital.giexchange.matcher

import org.apache.kafka.clients.consumer.*
import org.apache.kafka.clients.producer.KafkaProducer
import org.apache.kafka.clients.producer.ProducerConfig
import org.apache.kafka.clients.producer.ProducerRecord
import org.apache.kafka.clients.producer.RecordMetadata
import org.apache.kafka.common.TopicPartition
import org.apache.kafka.common.errors.WakeupException
import org.apache.kafka.common.serialization.StringDeserializer
import org.apache.kafka.common.serialization.StringSerializer
import org.slf4j.LoggerFactory
import space.davids_digital.giexchange.contracts.ContractsJson
import space.davids_digital.giexchange.contracts.MatchResult
import space.davids_digital.giexchange.contracts.OrderCommand
import space.davids_digital.giexchange.contracts.Topics
import java.time.Duration
import java.util.concurrent.Future

fun main() {
    val bootstrapServers = System.getenv("KAFKA_BOOTSTRAP_SERVERS") ?: "localhost:9092"
    val matcher = Matcher(bootstrapServers)

    // On SIGTERM (e.g. from Kubernetes) interrupt poll() and wait until run() has closed the clients
    val mainThread = Thread.currentThread()
    Runtime.getRuntime().addShutdownHook(Thread {
        matcher.wakeup()
        mainThread.join()
    })

    matcher.run()
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
class Matcher(bootstrapServers: String) {
    private val log = LoggerFactory.getLogger(javaClass)

    private val consumer = KafkaConsumer<String, String>(
        mapOf<String, Any>(
            ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG to bootstrapServers,
            ConsumerConfig.GROUP_ID_CONFIG to "matcher",
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
    }

    private val partitions = HashMap<Int, PartitionState>()

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
                process(consumer.poll(Duration.ofMillis(500)))
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

            if (record.offset() >= state.publishFrom) {
                for (result in results) {
                    val payload = ContractsJson.encodeToString<MatchResult>(result)
                    sends += producer.send(ProducerRecord(Topics.MATCH_RESULTS, result.marketKey.value, payload))
                }
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
