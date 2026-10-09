package space.davids_digital.giexchange.core.auth

import jakarta.servlet.http.HttpServletRequest
import org.springframework.context.annotation.Configuration
import org.springframework.context.annotation.Profile
import org.springframework.core.MethodParameter
import org.springframework.stereotype.Component
import org.springframework.web.bind.support.WebDataBinderFactory
import org.springframework.web.context.request.NativeWebRequest
import org.springframework.web.method.support.HandlerMethodArgumentResolver
import org.springframework.web.method.support.ModelAndViewContainer
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer
import space.davids_digital.giexchange.contracts.UserId
import space.davids_digital.giexchange.core.api.unauthorized

/** The user on whose behalf a request is made. Controllers receive it as a method parameter. */
data class AuthenticatedUser(val id: UserId)

/** Where the user comes from. The dev implementation trusts a header; the JWT one will verify a token. */
fun interface AuthenticatedUserResolver {
    fun resolve(request: HttpServletRequest): AuthenticatedUser?
}

/**
 * Development only: any client can claim to be any user.
 * Outside the dev profile there is no resolver at all, so the service refuses to start
 * until a real one exists, instead of silently accepting this header.
 */
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
class AuthenticationConfig(private val resolver: AuthenticatedUserResolver) : WebMvcConfigurer {
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
                return resolver.resolve(request) ?: throw unauthorized()
            }
        }
    }
}
