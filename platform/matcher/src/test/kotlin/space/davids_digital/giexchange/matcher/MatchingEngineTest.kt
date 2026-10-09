package space.davids_digital.giexchange.matcher

import space.davids_digital.giexchange.contracts.AssetId
import space.davids_digital.giexchange.contracts.CancelOrder
import space.davids_digital.giexchange.contracts.CancelRejected
import space.davids_digital.giexchange.contracts.CommandId
import space.davids_digital.giexchange.contracts.Credits
import space.davids_digital.giexchange.contracts.MarketKey
import space.davids_digital.giexchange.contracts.MatchResult
import space.davids_digital.giexchange.contracts.OrderClosed
import space.davids_digital.giexchange.contracts.OrderCommand
import space.davids_digital.giexchange.contracts.OrderId
import space.davids_digital.giexchange.contracts.OrderRested
import space.davids_digital.giexchange.contracts.PlaceOrder
import space.davids_digital.giexchange.contracts.Side
import space.davids_digital.giexchange.contracts.Side.BUY
import space.davids_digital.giexchange.contracts.Side.SELL
import space.davids_digital.giexchange.contracts.TakeListing
import space.davids_digital.giexchange.contracts.TimeInForce
import space.davids_digital.giexchange.contracts.TradeExecuted
import space.davids_digital.giexchange.contracts.UserId
import kotlin.random.Random
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class MatchingEngineTest {
    private val market = MarketKey("test-game/test-item")
    private val engine = MatchingEngine()
    private var nextCommandId = 1L

    @Test
    fun `buy order walks the book in price-time order and rests the remainder`() {
        engine.apply(place(7001, SELL, 300, 50))
        engine.apply(place(7002, SELL, 310, 25))
        engine.apply(place(7004, SELL, 310, 20))
        engine.apply(place(7003, SELL, 320, 40))

        val results = engine.apply(place(9001, BUY, 310, 100))

        assertEquals(
            listOf(
                "trade buy=9001 sell=7001 50@300 taker=BUY",
                "closed 7001 FILLED 0",
                "trade buy=9001 sell=7002 25@310 taker=BUY",
                "closed 7002 FILLED 0",
                "trade buy=9001 sell=7004 20@310 taker=BUY",
                "closed 7004 FILLED 0",
                "rested 9001 5",
            ),
            results.describe(),
        )
    }

    @Test
    fun `random command streams are deterministic and keep every order consistent`() {
        val random = Random(42)
        val commands = randomCommands(random, count = 10_000)
        val other = MatchingEngine()

        val quantity = HashMap<OrderId, Long>()
        val filled = HashMap<OrderId, Long>()
        val seen = HashSet<CommandId>()

        for (command in commands) {
            val results = engine.apply(command)
            assertEquals(results, other.apply(command), "Two engines disagree on $command")

            if (!seen.add(command.commandId)) {
                assertTrue(results.isEmpty(), "A repeated command produced results: $command")
                continue
            }

            when (command) {
                is PlaceOrder -> quantity[command.orderId] = command.quantity
                is TakeListing -> quantity[command.orderId] = 1
                is CancelOrder -> {}
            }

            for (result in results) {
                when (result) {
                    is TradeExecuted -> {
                        filled.merge(result.buyOrderId, result.quantity, Long::plus)
                        filled.merge(result.sellOrderId, result.quantity, Long::plus)
                    }
                    is OrderRested -> assertEquals(
                        quantity.getValue(result.orderId),
                        filled.getOrDefault(result.orderId, 0) + result.remainingQuantity,
                        "Quantities do not add up for $result",
                    )
                    is OrderClosed -> assertEquals(
                        quantity.getValue(result.orderId),
                        filled.getOrDefault(result.orderId, 0) + result.remainingQuantity,
                        "Quantities do not add up for $result",
                    )
                    is CancelRejected -> {}
                }
            }

            // The last result of a place or take is the terminal result of that very order
            val ownOrderId = when (command) {
                is PlaceOrder -> command.orderId
                is TakeListing -> command.orderId
                is CancelOrder -> null
            }
            if (ownOrderId != null) {
                val last = results.last()
                assertTrue(
                    (last is OrderRested && last.orderId == ownOrderId) || (last is OrderClosed && last.orderId == ownOrderId),
                    "Command $command did not end with its own terminal result: ${results.describe()}",
                )
            }
        }
    }

    @Test
    fun `FOK orders cancel immediately and have no effect on order book when there is not enough volume to fill`() {
        engine.apply(place(7001, SELL, 300, 50))
        engine.apply(place(7002, SELL, 290, 40))
        engine.apply(place(7003, SELL, 280, 30))

        // Should be unfilled because 75 > 40 + 30
        val results = engine.apply(place(9001, BUY, 290, 75, TimeInForce.FOK))

        assertEquals(
            listOf(
                "closed 9001 FOK_UNFILLED 75"
            ),
            results.describe(),
        )

        val after = engine.apply(place(9002, BUY, 290, 70, TimeInForce.IOC))

        assertEquals(
            listOf(
                "trade buy=9002 sell=7003 30@280 taker=BUY",
                "closed 7003 FILLED 0",
                "trade buy=9002 sell=7002 40@290 taker=BUY",
                "closed 7002 FILLED 0",
                "closed 9002 FILLED 0",
            ),
            after.describe(),
        )
    }

    @Test
    fun `FOK orders fill immediately when there is enough volume`() {
        engine.apply(place(7001, SELL, 300, 50))
        engine.apply(place(7002, SELL, 290, 40))
        engine.apply(place(7003, SELL, 280, 30))

        // Should be filled because 65 < 40 + 30
        val results = engine.apply(place(9001, BUY, 290, 65, TimeInForce.FOK))

        assertEquals(
            listOf(
                "trade buy=9001 sell=7003 30@280 taker=BUY",
                "closed 7003 FILLED 0",
                "trade buy=9001 sell=7002 35@290 taker=BUY",
                "closed 9001 FILLED 0"
            ),
            results.describe(),
        )
    }

    @Test
    fun `IOC orders fill partially and close when there is not enough volume`() {
        engine.apply(place(7001, SELL, 300, 50))
        engine.apply(place(7002, SELL, 290, 40))
        engine.apply(place(7003, SELL, 280, 30))

        val results = engine.apply(place(9001, BUY, 290, 75, TimeInForce.IOC))

        assertEquals(
            listOf(
                "trade buy=9001 sell=7003 30@280 taker=BUY",
                "closed 7003 FILLED 0",
                "trade buy=9001 sell=7002 40@290 taker=BUY",
                "closed 7002 FILLED 0",
                "closed 9001 IOC_UNFILLED 5"
            ),
            results.describe(),
        )
    }

    @Test
    fun `a sell order in order book with buy orders is filled with the buyer price`() {
        engine.apply(place(7001, BUY, 300, 38))
        engine.apply(place(7002, BUY, 290, 36))
        engine.apply(place(7003, BUY, 280, 42))

        val results = engine.apply(place(9001, SELL, 290, 40))

        assertEquals(
            listOf(
                "trade buy=7001 sell=9001 38@300 taker=SELL",
                "closed 7001 FILLED 0",
                "trade buy=7002 sell=9001 2@290 taker=SELL",
                "closed 9001 FILLED 0",
            ),
            results.describe(),
        )
    }

    @Test
    fun `take order filled if possible but rejected if target is unavailable`() {
        engine.apply(place(7001, SELL, 300, assetId = 1))
        engine.apply(place(7002, SELL, 290, assetId = 2))

        val resultA = engine.apply(take(9001, 7002, 290))
        val resultB = engine.apply(take(9002, 7002, 290))

        assertEquals(
            listOf(
                "trade buy=9001 sell=7002 1@290 taker=BUY asset=2",
                "closed 7002 FILLED 0",
                "closed 9001 FILLED 0",
            ),
            resultA.describe(),
        )
        assertEquals(
            listOf(
                "closed 9002 TARGET_UNAVAILABLE 1"
            ),
            resultB.describe(),
        )
    }

    @Test
    fun `take order is rejected if price does not match`() {
        engine.apply(place(7001, SELL, 300, assetId = 1))
        engine.apply(place(7002, SELL, 290, assetId = 2))

        val result = engine.apply(take(9001, 7002, 300))

        assertEquals(
            listOf(
                "closed 9001 TARGET_PRICE_MISMATCH 1"
            ),
            result.describe(),
        )
    }

    @Test
    fun `existing order can be canceled while nonexistent order can not`() {
        engine.apply(place(7001, BUY, 300, 38))
        engine.apply(place(7002, BUY, 290, 36))
        engine.apply(place(7003, BUY, 280, 42))

        val resultA = engine.apply(cancel(7002))
        val resultB = engine.apply(cancel(7002))

        assertEquals(
            listOf(
                "closed 7002 CANCELED 36"
            ),
            resultA.describe(),
        )
        assertEquals(
            listOf(
                "cancel-rejected 7002"
            ),
            resultB.describe(),
        )
    }

    @Test
    fun `repeating the same command does nothing`() {
        val resultA = engine.apply(place(7002, BUY, 300, 20, commandId = 42))
        val resultB = engine.apply(place(7002, BUY, 300, 20, commandId = 42))

        assertEquals(
            listOf(
                "rested 7002 20"
            ),
            resultA.describe(),
        )
        assertEquals(listOf(), resultB.describe())
    }

    @Test
    fun `orders with same price are executed in fifo order`() {
        engine.apply(place(7001, BUY, 300, 1, commandId = 42))
        engine.apply(place(7004, BUY, 300, 1, commandId = 41))
        engine.apply(place(7003, BUY, 300, 1, commandId = 40))
        engine.apply(place(7002, BUY, 300, 1, commandId = 43))

        val result = engine.apply(place(9001, SELL, 300, 4))
        assertEquals(
            listOf(
                "trade buy=7001 sell=9001 1@300 taker=SELL",
                "closed 7001 FILLED 0",
                "trade buy=7004 sell=9001 1@300 taker=SELL",
                "closed 7004 FILLED 0",
                "trade buy=7003 sell=9001 1@300 taker=SELL",
                "closed 7003 FILLED 0",
                "trade buy=7002 sell=9001 1@300 taker=SELL",
                "closed 7002 FILLED 0",
                "closed 9001 FILLED 0"
            ),
            result.describe(),
        )
    }

    // ---------- helpers ----------

    private fun place(
        orderId: Long,
        side: Side,
        price: Long,
        quantity: Long = 1,
        timeInForce: TimeInForce = TimeInForce.GTC,
        ownerId: Long = orderId,
        assetId: Long? = null,
        commandId: Long = nextCommandId++
    ) = PlaceOrder(
        commandId = CommandId(commandId),
        marketKey = market,
        issuedAt = 0,
        orderId = OrderId(orderId),
        ownerId = UserId(ownerId),
        side = side,
        price = Credits(price),
        quantity = quantity,
        timeInForce = timeInForce,
        assetId = assetId?.let { AssetId(it) },
    )

    private fun take(
        orderId: Long,
        targetOrderId: Long,
        price: Long,
        ownerId: Long = orderId,
    ) = TakeListing(
        commandId = CommandId(nextCommandId++),
        marketKey = market,
        issuedAt = 0,
        orderId = OrderId(orderId),
        ownerId = UserId(ownerId),
        targetOrderId = OrderId(targetOrderId),
        price = Credits(price),
    )

    private fun cancel(
        orderId: Long,
    ) = CancelOrder(
        commandId = CommandId(nextCommandId++),
        marketKey = market,
        issuedAt = 0,
        orderId = OrderId(orderId),
    )

    /** Results as short strings, so expected sequences read like the step-by-step tables. */
    private fun List<MatchResult>.describe(): List<String> = map {
        when (it) {
            is TradeExecuted -> buildString {
                append("trade buy=${it.buyOrderId.value} sell=${it.sellOrderId.value} ${it.quantity}@${it.price.amount} taker=${it.takerSide}")
                it.assetId?.let { asset -> append(" asset=${asset.value}") }
            }
            is OrderRested -> "rested ${it.orderId.value} ${it.remainingQuantity}"
            is OrderClosed -> "closed ${it.orderId.value} ${it.reason} ${it.remainingQuantity}"
            is CancelRejected -> "cancel-rejected ${it.orderId.value}"
        }
    }

    /** Places, cancels, takes and repeats of earlier commands, around a narrow price range so that orders cross often. */
    private fun randomCommands(random: Random, count: Int): List<OrderCommand> {
        val commands = mutableListOf<OrderCommand>()
        var nextOrderId = 1L
        for (i in 1..count) {
            val commandId = CommandId(i.toLong())
            val issuedAt = i.toLong()
            val owner = UserId(random.nextLong(1, 6))
            val command: OrderCommand = when (random.nextInt(10)) {
                0 -> if (commands.isEmpty()) continue else commands.random(random)
                1 -> CancelOrder(commandId, market, issuedAt, OrderId(random.nextLong(1, nextOrderId + 1)))
                2 -> TakeListing(
                    commandId = commandId,
                    marketKey = market,
                    issuedAt = issuedAt,
                    orderId = OrderId(nextOrderId++),
                    ownerId = owner,
                    targetOrderId = OrderId(random.nextLong(1, nextOrderId)),
                    price = Credits(random.nextLong(95, 106)),
                )
                else -> PlaceOrder(
                    commandId = commandId,
                    marketKey = market,
                    issuedAt = issuedAt,
                    orderId = OrderId(nextOrderId++),
                    ownerId = owner,
                    side = if (random.nextBoolean()) BUY else SELL,
                    price = Credits(random.nextLong(95, 106)),
                    quantity = random.nextLong(1, 21),
                    timeInForce = TimeInForce.entries.random(random),
                )
            }
            commands += command
        }
        return commands
    }
}
