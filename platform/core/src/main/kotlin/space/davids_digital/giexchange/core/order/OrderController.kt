package space.davids_digital.giexchange.core.order

import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController
import space.davids_digital.giexchange.contracts.Side
import space.davids_digital.giexchange.contracts.TimeInForce
import space.davids_digital.giexchange.core.auth.AuthenticatedUser
import java.net.URI

data class PlaceOrderRequest(
    /** Chosen by the client once per user intent and reused on retries. */
    val clientOrderId: String,
    val marketId: Long,
    val side: Side,
    val price: Long,
    val quantity: Long,
    val timeInForce: TimeInForce = TimeInForce.GTC,
    /** Sell order of a unique item: the item being sold. */
    val assetId: Long? = null,
    /** Buying a specific listing: the sell order being bought. */
    val targetOrderId: Long? = null,
)

data class PlaceOrderResponse(val orderId: Long, val status: OrderStatus)

@RestController
@RequestMapping("/api/v1/orders")
class OrderController(private val orders: OrderService) {

    /** 202 for a new order: it is accepted, not executed yet. 200 for a retry of an earlier request. */
    @PostMapping
    fun place(user: AuthenticatedUser, @RequestBody request: PlaceOrderRequest): ResponseEntity<PlaceOrderResponse> {
        val result = orders.place(user.id, request)
        val response = if (result.created) ResponseEntity.accepted() else ResponseEntity.ok()
        return response
            .location(URI.create("/api/v1/orders/${result.orderId}"))
            .body(PlaceOrderResponse(result.orderId, result.status))
    }

    @GetMapping("/{orderId}")
    fun get(user: AuthenticatedUser, @PathVariable orderId: Long): OrderView =
        orders.get(user.id, orderId)

    @PostMapping("/{orderId}/cancel")
    fun cancel(user: AuthenticatedUser, @PathVariable orderId: Long): ResponseEntity<Void> {
        orders.requestCancel(user.id, orderId)
        return ResponseEntity.accepted().build()
    }
}
