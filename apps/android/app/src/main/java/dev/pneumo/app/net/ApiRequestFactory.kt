package dev.pneumo.app.net

import dev.pneumo.app.protocol.ProtocolJson
import kotlinx.serialization.SerializationStrategy
import okhttp3.HttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody

internal class ApiRequestFactory(private val origin: HttpUrl, bearerToken: String?) {
    private val authorizationValue = bearerToken?.let { "$BEARER_PREFIX$it" }

    init {
        require(origin.scheme == HTTP_SCHEME || origin.scheme == HTTPS_SCHEME) {
            "Server origin must use HTTP or HTTPS"
        }
        require(
            origin.username.isEmpty() &&
                origin.password.isEmpty() &&
                origin.encodedPath == ROOT_PATH &&
                origin.query == null &&
                origin.fragment == null
        ) {
            "Server URL must be an origin without credentials, path, query, or fragment"
        }
        bearerToken?.let { token ->
            require(isBearerToken(token)) { "Bearer token must be canonical base64url for 32 bytes" }
        }
    }

    fun authenticated(url: HttpUrl): Request.Builder = Request.Builder()
        .url(url)
        .header(AUTHORIZATION_HEADER, requireAuthorizationValue())

    fun unauthenticated(url: HttpUrl): Request.Builder = Request.Builder().url(url)

    fun apiUrl(path: String, id: String? = null): HttpUrl {
        val builder = origin.newBuilder().encodedPath(path)
        if (id != null) {
            builder.addPathSegment(id)
        }
        return builder.build()
    }

    fun fileContentUrl(fileId: String): HttpUrl = origin.newBuilder()
        .encodedPath(FILES_PATH)
        .addPathSegment(fileId)
        .addPathSegment(CONTENT_PATH_SEGMENT)
        .build()

    fun <T> jsonBody(serializer: SerializationStrategy<T>, value: T): RequestBody =
        ProtocolJson.encodeToString(serializer, value).toRequestBody(JSON_MEDIA_TYPE)

    private fun requireAuthorizationValue(): String =
        checkNotNull(authorizationValue) { "Bearer token is required for this request" }

    private fun isBearerToken(value: String): Boolean = value.length == BEARER_TOKEN_LENGTH &&
        BASE64_URL_PATTERN.matches(value) &&
        value.last() in BEARER_TOKEN_TRAILING_CHARS

    companion object {
        const val AUTHORIZATION_HEADER = "Authorization"
        const val FILES_PATH = "/api/files"
        private const val CONTENT_PATH_SEGMENT = "content"
        private const val ROOT_PATH = "/"
        private const val HTTP_SCHEME = "http"
        private const val HTTPS_SCHEME = "https"
        private const val BEARER_PREFIX = "Bearer "
        private const val BEARER_TOKEN_LENGTH = 43
        private const val BEARER_TOKEN_TRAILING_CHARS = "AEIMQUYcgkosw048"
        private val BASE64_URL_PATTERN = Regex("^[A-Za-z0-9_-]+$")
        private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
    }
}
