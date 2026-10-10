package space.davids_digital.giexchange.core.internal

import org.springframework.beans.factory.annotation.Value
import org.springframework.dao.DuplicateKeyException
import org.springframework.http.HttpStatus
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Component
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestHeader
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.ResponseStatus
import org.springframework.web.bind.annotation.RestController
import space.davids_digital.giexchange.contracts.UserId
import space.davids_digital.giexchange.core.api.forbidden
import space.davids_digital.giexchange.core.api.invalidRequest
import space.davids_digital.giexchange.core.api.notFound
import space.davids_digital.giexchange.core.api.unprocessable
import space.davids_digital.giexchange.core.auth.TokenService
import space.davids_digital.giexchange.core.ledger.Grants
import space.davids_digital.giexchange.core.user.IdentityProvider
import space.davids_digital.giexchange.core.user.Users
import java.security.MessageDigest
import java.time.Duration

/**
 * The shared secret of the internal API. The gateway never forwards /internal, so the secret is a
 * second line of defense for anything else that can reach core inside the network.
 * An empty secret turns the internal API off.
 */
@Component
class InternalAccess(@Value($$"${giexchange.internal.token:}") token: String) {
    private val expected = token.toByteArray(Charsets.UTF_8)

    fun check(provided: String?) {
        if (expected.isEmpty()) {
            throw notFound("Endpoint")
        }
        // Constant time: the comparison must not reveal how much of a guess was right
        if (provided == null || !MessageDigest.isEqual(expected, provided.toByteArray(Charsets.UTF_8))) {
            throw forbidden()
        }
    }
}

data class BotRequest(val name: String)

data class BotSession(val userId: Long, val displayName: String, val token: String)

data class GrantRequest(val credits: Long = 0, val items: List<GrantItem> = emptyList()) {
    data class GrantItem(val marketId: Long, val quantity: Long)
}

@Service
class InternalService(
    private val jdbc: JdbcClient,
    private val users: Users,
    private val grants: Grants,
    private val tokens: TokenService,
) {
    /** Gets or creates the bot user and issues a fresh token for it. */
    @Transactional
    fun signInBot(name: String): BotSession {
        val userId = users.findByIdentity(IdentityProvider.BOT, name)
            ?: users.create(IdentityProvider.BOT, name, name)
        val token = tokens.issue(userId, BOT_TOKEN_TTL)
        return BotSession(userId.value, name, token.token)
    }

    @Transactional
    fun grant(userId: UserId, request: GrantRequest) {
        if (request.credits !in 0..MAX_CREDITS) {
            throw invalidRequest("credits must be between 0 and $MAX_CREDITS")
        }
        if (request.items.any { it.quantity !in 1..MAX_QUANTITY }) {
            throw invalidRequest("Item quantities must be between 1 and $MAX_QUANTITY")
        }
        if (!users.exists(userId)) {
            throw notFound("User ${userId.value}")
        }
        if (request.credits > 0) {
            grants.credits(userId, request.credits, "internal-grant:${userId.value}")
        }
        for (item in request.items) {
            val marketKey = jdbc.sql("select market_key from markets where market_id = :id")
                .param("id", item.marketId)
                .query(String::class.java)
                .optional()
                .orElseThrow { notFound("Market ${item.marketId}") }
            if (!grants.items(userId, marketKey, item.quantity)) {
                throw unprocessable("not-fungible", "Not fungible", "Market ${item.marketId} does not trade fungible items")
            }
        }
    }

    private companion object {
        val BOT_TOKEN_TTL: Duration = Duration.ofDays(30)
        const val MAX_CREDITS = 1_000_000_000_000L
        const val MAX_QUANTITY = 1_000_000_000L
    }
}

@RestController
@RequestMapping("/internal/v1")
class InternalController(private val access: InternalAccess, private val service: InternalService) {

    @PostMapping("/bots")
    fun bot(
        @RequestHeader(TOKEN_HEADER, required = false) token: String?,
        @RequestBody request: BotRequest,
    ): BotSession {
        access.check(token)
        if (!BOT_NAME.matches(request.name)) {
            throw invalidRequest("name must be 1 to 32 characters: lowercase letters, digits and dashes")
        }
        return try {
            service.signInBot(request.name)
        } catch (e: DuplicateKeyException) {
            // Two requests created the same bot at once: the other one won, so this one finds it
            service.signInBot(request.name)
        }
    }

    @PostMapping("/users/{userId}/grants")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun grant(
        @RequestHeader(TOKEN_HEADER, required = false) token: String?,
        @PathVariable userId: Long,
        @RequestBody request: GrantRequest,
    ) {
        access.check(token)
        if (userId <= 0) {
            throw notFound("User $userId")
        }
        service.grant(UserId(userId), request)
    }

    private companion object {
        const val TOKEN_HEADER = "X-Internal-Token"
        val BOT_NAME = Regex("^[a-z0-9-]{1,32}$")
    }
}
