package space.davids_digital.giexchange.core.api

import org.springframework.http.HttpStatus
import org.springframework.http.HttpStatusCode
import org.springframework.http.ProblemDetail
import org.springframework.web.ErrorResponseException
import java.net.URI

/**
 * An error returned to the client as RFC 9457 Problem Details.
 * Clients branch on the type, a stable machine-readable code; the detail is for humans.
 */
class ApiException(status: HttpStatusCode, type: String, title: String, detail: String) :
    ErrorResponseException(status, problem(status, type, title, detail), null)

private fun problem(status: HttpStatusCode, type: String, title: String, detail: String): ProblemDetail =
    ProblemDetail.forStatusAndDetail(status, detail).apply {
        this.type = URI.create("/problems/$type")
        this.title = title
    }

private val UNPROCESSABLE_CONTENT: HttpStatusCode = HttpStatusCode.valueOf(422)

fun invalidRequest(detail: String) =
    ApiException(HttpStatus.BAD_REQUEST, "invalid-request", "Invalid request", detail)

fun unauthorized() =
    ApiException(HttpStatus.UNAUTHORIZED, "unauthorized", "Unauthorized", "The request is not authenticated")

fun notFound(what: String) =
    ApiException(HttpStatus.NOT_FOUND, "not-found", "Not found", "$what not found")

fun conflict(type: String, title: String, detail: String) =
    ApiException(HttpStatus.CONFLICT, type, title, detail)

fun unprocessable(type: String, title: String, detail: String) =
    ApiException(UNPROCESSABLE_CONTENT, type, title, detail)

fun forbidden() =
    ApiException(HttpStatus.FORBIDDEN, "forbidden", "Forbidden", "The request is not allowed")

fun tooManyRequests(type: String, title: String, detail: String) =
    ApiException(HttpStatus.TOO_MANY_REQUESTS, type, title, detail)
