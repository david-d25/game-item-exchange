package space.davids_digital.giexchange.core.auth

import jakarta.servlet.http.HttpServletRequest
import org.springframework.context.annotation.Configuration
import org.springframework.context.annotation.Profile
import org.springframework.core.MethodParameter
import org.springframework.http.HttpHeaders
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Component
import org.springframework.web.bind.support.WebDataBinderFactory
import org.springframework.web.context.request.NativeWebRequest
import org.springframework.web.method.support.HandlerMethodArgumentResolver
import org.springframework.web.method.support.ModelAndViewContainer
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer
import space.davids_digital.giexchange.contracts.UserId
import space.davids_digital.giexchange.core.api.unauthorized
import java.time.OffsetDateTime
import java.time.ZoneOffset

/** The user on whose behalf a request is made. Controllers receive it as a method parameter. */
data class AuthenticatedUser(val id: UserId)

/** One way of telling who makes a request. The first resolver that recognizes the request wins. */
fun interface AuthenticatedUserResolver {
    fun resolve(request: HttpServletRequest): AuthenticatedUser?
}

/** `Authorization: Bearer <token>` with a token from [TokenService]. */
@Component
class BearerTokenUserResolver(
    private val tokens: TokenService,
    private val jdbc: JdbcClient,
) : AuthenticatedUserResolver {
    override fun resolve(request: HttpServletRequest): AuthenticatedUser? {
        val header = request.getHeader(HttpHeaders.AUTHORIZATION) ?: return null
        if (!header.startsWith(PREFIX, ignoreCase = true)) {
            return null
        }
        val token = tokens.verify(header.substring(PREFIX.length).trim()) ?: return null
        // A valid signature is not enough after a database reset: the user may be gone, and the client
        // should get a 401 and sign in again rather than errors everywhere. Worse, ids start from 1 again,
        // so the same id may now belong to someone else: a token issued before the user was created
        // is not theirs. The margin covers the token time being cut to whole seconds and clock skew.
        val valid = jdbc.sql(
            """
            select exists (
                select 1 from users
                where user_id = :id and created_at <= :issuedAt + interval '$CLOCK_MARGIN_SECONDS seconds'
            )
            """
        )
            .param("id", token.userId.value)
            .param("issuedAt", OffsetDateTime.ofInstant(token.issuedAt, ZoneOffset.UTC))
            .query(Boolean::class.javaObjectType)
            .single()
        return if (valid) AuthenticatedUser(token.userId) else null
    }

    private companion object {
        const val PREFIX = "Bearer "
        const val CLOCK_MARGIN_SECONDS = 5
    }
}

/** Development only: any client can claim to be any user. Does not exist outside the dev profile. */
@Component
@Profile("dev")
class DevHeaderUserResolver : AuthenticatedUserResolver {
    override fun resolve(request: HttpServletRequest): AuthenticatedUser? =
        request.getHeader("X-Dev-User-Id")
            ?.toLongOrNull()
            ?.takeIf { it > 0 }
            ?.let { AuthenticatedUser(UserId(it)) }
}

@Configuration
class AuthenticationConfig(private val resolvers: List<AuthenticatedUserResolver>) : WebMvcConfigurer {
    override fun addArgumentResolvers(resolvers: MutableList<HandlerMethodArgumentResolver>) {
        resolvers += object : HandlerMethodArgumentResolver {
            override fun supportsParameter(parameter: MethodParameter) =
                parameter.parameterType == AuthenticatedUser::class.java

            override fun resolveArgument(
                parameter: MethodParameter,
                mavContainer: ModelAndViewContainer?,
                webRequest: NativeWebRequest,
                binderFactory: WebDataBinderFactory?,
            ): Any {
                val request = webRequest.getNativeRequest(HttpServletRequest::class.java) ?: throw unauthorized()
                return this@AuthenticationConfig.resolvers.firstNotNullOfOrNull { it.resolve(request) }
                    ?: throw unauthorized()
            }
        }
    }
}
