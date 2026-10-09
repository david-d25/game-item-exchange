package space.davids_digital.giexchange.contracts

import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonObject
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import kotlin.test.assertEquals
import kotlin.test.assertIs

class OrderCommandsTest {
    @Test
    fun `PlaceOrder command can be deserialized from json`() {
        val json = """
            {
                "type": "place",
                "commandId": 435345,
                "marketKey": "my-game/my-item?attr=value&attr2=value2",
                "issuedAt": 9292929292,
                "orderId": 2222222,
                "ownerId": 1234,
                "side": "SELL",
                "price": 99999999,
                "quantity": 1,
                "assetId": 88005553535,
                "timeInForce": "FOK"
            }
        """.trimIndent()
        val sample = PlaceOrder(
            commandId = CommandId(435345),
            marketKey = MarketKey("my-game/my-item?attr=value&attr2=value2"),
            issuedAt = 9292929292,
            orderId = OrderId(2222222),
            ownerId = UserId(1234),
            side = Side.SELL,
            price = Credits(99999999),
            quantity = 1,
            assetId = AssetId(88005553535),
            timeInForce = TimeInForce.FOK
        )
        val decoded = ContractsJson.decodeFromString<OrderCommand>(json)
        assertIs<PlaceOrder>(decoded)
        assertEquals(sample, decoded)
    }

    @Test
    fun `PlaceOrder object creation requirements are enforced`() {
        assertThrows<IllegalArgumentException> {
            PlaceOrder(
                commandId = CommandId(1),
                marketKey = MarketKey("test/test"),
                issuedAt = 1,
                orderId = OrderId(1),
                ownerId = UserId(1),
                side = Side.BUY, // <---
                price = Credits(1),
                assetId = AssetId(1), // <---
                quantity = 1
            )
        }
        assertThrows<IllegalArgumentException> {
            PlaceOrder(
                commandId = CommandId(1),
                marketKey = MarketKey("test/test"),
                issuedAt = 1,
                orderId = OrderId(1),
                ownerId = UserId(1),
                side = Side.SELL,
                price = Credits(1),
                assetId = AssetId(1), // <---
                quantity = 2 // <---
            )
        }
        assertThrows<IllegalArgumentException> {
            PlaceOrder(
                commandId = CommandId(1),
                marketKey = MarketKey("test/test"),
                issuedAt = 1,
                orderId = OrderId(1),
                ownerId = UserId(1),
                side = Side.SELL,
                price = Credits(1),
                quantity = 0 // <---
            )
        }
    }

    @Test
    fun `PlaceOrder defaults are applied and unknown fields are ignored`() {
        val json = """{"type":"place","commandId":1,"marketKey":"g/i","issuedAt":1,"orderId":1,
        "ownerId":1,"side":"BUY","price":10,"quantity":5,"someFutureField":"x"}"""
        val decoded = assertIs<PlaceOrder>(ContractsJson.decodeFromString<OrderCommand>(json))
        assertEquals(null, decoded.assetId)
        assertEquals(TimeInForce.GTC, decoded.timeInForce)
    }

    @Test
    fun `CancelOrder command can be deserialized from json`() {
        val json = """
            {
                "type": "cancel",
                "commandId": 1234,
                "marketKey": "my-game/my-item",
                "issuedAt": 2222,
                "orderId": 123456
            }
        """.trimIndent()
        val sample = CancelOrder(
            commandId = CommandId(1234),
            marketKey = MarketKey("my-game/my-item"),
            issuedAt = 2222,
            orderId = OrderId(123456),
        )
        val decoded = ContractsJson.decodeFromString<OrderCommand>(json)
        assertIs<CancelOrder>(decoded)
        assertEquals(sample, decoded)
    }

    @Test
    fun `TakeListing command can be deserialized from json`() {
        val json = """
            {
                "type": "take",
                "commandId": 1234,
                "marketKey": "my-game/my-item",
                "issuedAt": 2222,
                "orderId": 123456,
                "ownerId": 555,
                "targetOrderId": 111,
                "price": 888
            }
        """.trimIndent()
        val sample = TakeListing(
            commandId = CommandId(1234),
            marketKey = MarketKey("my-game/my-item"),
            issuedAt = 2222,
            orderId = OrderId(123456),
            ownerId = UserId(555),
            targetOrderId = OrderId(111),
            price = Credits(888),
        )
        val decoded = ContractsJson.decodeFromString<OrderCommand>(json)
        assertIs<TakeListing>(decoded)
        assertEquals(sample, decoded)
    }

    @Test
    fun `Default values are written to JSON explicitly`() {
        val command: OrderCommand = PlaceOrder(
            commandId = CommandId(1),
            marketKey = MarketKey("g/i"),
            issuedAt = 1,
            orderId = OrderId(1),
            ownerId = UserId(1),
            side = Side.BUY,
            price = Credits(10),
            quantity = 5,
        )
        val fields = ContractsJson.encodeToJsonElement(command).jsonObject
        assertEquals(JsonPrimitive("place"), fields["type"])
        assertEquals(JsonPrimitive("GTC"), fields["timeInForce"])
        assertEquals(JsonNull, fields["assetId"])
    }
}
