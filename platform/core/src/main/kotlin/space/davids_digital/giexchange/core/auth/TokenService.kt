package space.davids_digital.giexchange.core.auth

import com.nimbusds.jose.JOSEException
import com.nimbusds.jose.JWSAlgorithm
import com.nimbusds.jose.JWSHeader
import com.nimbusds.jose.crypto.MACSigner
import com.nimbusds.jose.crypto.MACVerifier
import com.nimbusds.jwt.JWTClaimsSet
import com.nimbusds.jwt.SignedJWT
import org.springframework.beans.factory.annotation.Value
import org.springframework.stereotype.Component
import space.davids_digital.giexchange.contracts.UserId
import java.text.ParseException
import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.time.temporal.ChronoUnit
import java.util.Date

data class IssuedToken(val token: String, val expiresAt: Instant)

data class VerifiedToken(val userId: UserId, val issuedAt: Instant)

/**
 * Issues and checks the bearer tokens of guests and bots: JWTs signed with HMAC-SHA256.
 *
 * The secret must be at least 32 bytes; core refuses to start without one, so a deployment
 * cannot end up signing tokens with an empty or default key by accident.
 */
@Component
class TokenService(
    @Value($$"${giexchange.auth.secret}") secret: String,
    private val clock: Clock,
) {
    private val key = secret.toByteArray(Charsets.UTF_8)

    init {
        require(key.size >= 32) { "giexchange.auth.secret must be at least 32 bytes long" }
    }

    private val signer = MACSigner(key)
    private val verifier = MACVerifier(key)

    fun issue(userId: UserId, ttl: Duration): IssuedToken {
        val now = clock.instant().truncatedTo(ChronoUnit.SECONDS)
        val expiresAt = now.plus(ttl)
        val claims = JWTClaimsSet.Builder()
            .issuer(ISSUER)
            .subject(userId.value.toString())
            .issueTime(Date.from(now))
            .expirationTime(Date.from(expiresAt))
            .build()
        val jwt = SignedJWT(JWSHeader(JWSAlgorithm.HS256), claims)
        jwt.sign(signer)
        return IssuedToken(jwt.serialize(), expiresAt)
    }

    /** Who the token was issued to and when, or null if it is malformed, signed with another key or expired. */
    fun verify(token: String): VerifiedToken? {
        val jwt = try {
            SignedJWT.parse(token)
        } catch (e: ParseException) {
            return null
        }
        // Only the algorithm we issue: never let the token choose how it is checked
        if (jwt.header.algorithm != JWSAlgorithm.HS256) {
            return null
        }
        val valid = try {
            jwt.verify(verifier)
        } catch (e: JOSEException) {
            false
        }
        if (!valid) {
            return null
        }
        val claims = try {
            jwt.jwtClaimsSet
        } catch (e: ParseException) {
            return null
        }
        if (claims.issuer != ISSUER) {
            return null
        }
        val expiresAt = claims.expirationTime?.toInstant() ?: return null
        if (!expiresAt.isAfter(clock.instant())) {
            return null
        }
        val issuedAt = claims.issueTime?.toInstant() ?: return null
        val userId = claims.subject?.toLongOrNull()?.takeIf { it > 0 } ?: return null
        return VerifiedToken(UserId(userId), issuedAt)
    }

    private companion object {
        const val ISSUER = "giexchange"
    }
}
