package dev.pneumo.app.net

import dev.pneumo.app.protocol.DownloadTarget
import dev.pneumo.app.protocol.UploadTarget
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Request
import okhttp3.RequestBody

internal class TransferRequestFactory(private val origin: HttpUrl, private val bearerToken: String?) {
    private val authorizationValue = bearerToken?.let { "$BEARER_PREFIX$it" }

    fun upload(target: UploadTarget, body: RequestBody): Request {
        require(target.method == PUT_METHOD) { "File upload method must be PUT" }
        return request(target.url, target.headers).put(body).build()
    }

    fun download(target: DownloadTarget): Request = request(target.url, target.headers).get().build()

    private fun request(targetUrl: String, headers: Map<String, String>): Request.Builder {
        val relative = isRelative(targetUrl)
        val builder = Request.Builder().url(transferUrl(targetUrl))
        for ((name, value) in headers) {
            require(relative || !containsBearerCredential(name, value)) {
                "Bearer credentials are not permitted for external transfers"
            }
            try {
                builder.header(name, value)
            } catch (ignored: IllegalArgumentException) {
                throw IllegalArgumentException("Invalid transfer header")
            }
        }
        if (relative) {
            builder.header(ApiRequestFactory.AUTHORIZATION_HEADER, requireAuthorizationValue())
        }
        return builder
    }

    private fun transferUrl(value: String): HttpUrl {
        if (isRelative(value)) {
            return origin.resolve(value) ?: throw IllegalArgumentException("Invalid relative transfer URL")
        }
        return try {
            value.toHttpUrl()
        } catch (ignored: IllegalArgumentException) {
            throw IllegalArgumentException("Invalid external transfer URL")
        }
    }

    private fun containsBearerCredential(name: String, value: String): Boolean =
        (bearerToken != null && value.contains(bearerToken)) ||
            (
                name.equals(ApiRequestFactory.AUTHORIZATION_HEADER, ignoreCase = true) &&
                    value.startsWith(BEARER_PREFIX, ignoreCase = true)
                )

    private fun isRelative(value: String): Boolean = value.startsWith(ROOT_PATH) && !value.startsWith(DOUBLE_SLASH)

    private fun requireAuthorizationValue(): String =
        checkNotNull(authorizationValue) { "Bearer token is required for this request" }

    companion object {
        private const val PUT_METHOD = "PUT"
        private const val ROOT_PATH = "/"
        private const val DOUBLE_SLASH = "//"
        private const val BEARER_PREFIX = "Bearer "
    }
}
