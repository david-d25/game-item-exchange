package space.davids_digital.giexchange.core.user

import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Component
import org.springframework.transaction.annotation.Propagation
import org.springframework.transaction.annotation.Transactional
import space.davids_digital.giexchange.contracts.UserId
import java.sql.Types

enum class IdentityProvider { PASSWORD, GUEST, BOT }

@Component
class Users(private val jdbc: JdbcClient) {

    /** Creates a user with one way of signing in and the two empty credit accounts every user has. */
    @Transactional(propagation = Propagation.MANDATORY)
    fun create(provider: IdentityProvider, subject: String, displayName: String?): UserId {
        val userId = jdbc.sql("insert into users (display_name) values (:name) returning user_id")
            .param("name", displayName, Types.VARCHAR)
            .query(Long::class.javaObjectType)
            .single()
        jdbc.sql("insert into user_identities (provider, subject, user_id) values (:provider, :subject, :user)")
            .param("provider", provider.name)
            .param("subject", subject)
            .param("user", userId)
            .update()
        jdbc.sql("insert into accounts (owner_id, kind) values (:user, 'AVAILABLE'), (:user, 'RESERVED')")
            .param("user", userId)
            .update()
        return UserId(userId)
    }

    @Transactional(propagation = Propagation.MANDATORY)
    fun setDisplayName(userId: UserId, displayName: String) {
        jdbc.sql("update users set display_name = :name where user_id = :user")
            .param("name", displayName)
            .param("user", userId.value)
            .update()
    }

    fun findByIdentity(provider: IdentityProvider, subject: String): UserId? =
        jdbc.sql("select user_id from user_identities where provider = :provider and subject = :subject")
            .param("provider", provider.name)
            .param("subject", subject)
            .query(Long::class.javaObjectType)
            .optional()
            .map(::UserId)
            .orElse(null)

    fun exists(userId: UserId): Boolean =
        jdbc.sql("select exists (select 1 from users where user_id = :user)")
            .param("user", userId.value)
            .query(Boolean::class.javaObjectType)
            .single()

    /** The name shown in the interface; users without one get a generated name. */
    fun displayName(userId: UserId): String =
        jdbc.sql("select display_name from users where user_id = :user")
            .param("user", userId.value)
            .query { rs, _ -> rs.getString("display_name") }
            .optional()
            .orElse(null)
            ?: "User ${userId.value}"
}
