package space.davids_digital.giexchange.core.user

import org.slf4j.LoggerFactory
import org.springframework.boot.context.properties.ConfigurationProperties
import org.springframework.http.HttpStatus
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.ResponseStatus
import org.springframework.web.bind.annotation.RestController
import space.davids_digital.giexchange.core.api.tooManyRequests
import space.davids_digital.giexchange.core.auth.TokenService
import space.davids_digital.giexchange.core.ledger.Grants
import java.time.Duration
import java.time.Instant
import java.util.UUID

@ConfigurationProperties("giexchange.guest")
data class GuestProperties(
    /** Guests created per hour across everyone; the gateway also limits each IP separately. */
    val maxPerHour: Int = 300,
    val tokenTtl: Duration = Duration.ofDays(30),
    val starterCredits: Long = 50_000,
    val starterItems: List<StarterItem> = emptyList(),
) {
    data class StarterItem(val marketKey: String, val quantity: Long)
}

data class SessionResponse(val token: String, val userId: Long, val displayName: String, val expiresAt: Instant)

@Service
class GuestService(
    private val jdbc: JdbcClient,
    private val users: Users,
    private val grants: Grants,
    private val tokens: TokenService,
    private val properties: GuestProperties,
) {
    private val log = LoggerFactory.getLogger(javaClass)

    /** A new user with a starter pack, signed in by the returned token alone. */
    @Transactional
    fun create(): SessionResponse {
        val recent = jdbc.sql(
            "select count(*) from user_identities where provider = 'GUEST' and created_at > now() - interval '1 hour'"
        )
            .query(Long::class.javaObjectType)
            .single()
        if (recent >= properties.maxPerHour) {
            throw tooManyRequests(
                "too-many-guests",
                "Too many guests",
                "Too many guest accounts were created recently, try again later",
            )
        }

        // The token is the only credential, so the identity subject only has to be unique
        val userId = users.create(IdentityProvider.GUEST, UUID.randomUUID().toString(), null)
        val displayName = "Guest ${userId.value}"
        users.setDisplayName(userId, displayName)

        if (properties.starterCredits > 0) {
            grants.credits(userId, properties.starterCredits, "guest:${userId.value}")
        }
        for (item in properties.starterItems) {
            if (!grants.items(userId, item.marketKey, item.quantity)) {
                log.warn("Starter item market {} does not exist or is not fungible, skipped", item.marketKey)
            }
        }

        val token = tokens.issue(userId, properties.tokenTtl)
        return SessionResponse(token.token, userId.value, displayName, token.expiresAt)
    }
}

@RestController
@RequestMapping("/api/v1/auth")
class AuthController(private val guests: GuestService) {

    @PostMapping("/guest")
    @ResponseStatus(HttpStatus.CREATED)
    fun guest(): SessionResponse = guests.create()
}
