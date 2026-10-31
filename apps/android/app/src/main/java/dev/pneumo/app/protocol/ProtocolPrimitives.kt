package dev.pneumo.app.protocol

import java.time.LocalDateTime
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeFormatterBuilder
import java.time.format.DateTimeParseException
import java.time.format.ResolverStyle
import java.util.Locale
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L
private const val BASE64_BLOCK_SIZE = 4
private const val BASE64_BYTES_PER_FULL_BLOCK = 3
private const val BASE64_TWO_CHARACTER_REMAINDER = 2
private const val BASE64_THREE_CHARACTER_REMAINDER = 3
private val uuidV7Pattern = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
private val base64UrlPattern = Regex("^[A-Za-z0-9_-]*$")
private val httpUrlPrefixPattern = Regex("^https?://", RegexOption.IGNORE_CASE)
private val isoTimestampPattern = Regex("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$")
private val isoTimestampFormatter: DateTimeFormatter =
    DateTimeFormatterBuilder()
        .appendPattern("uuuu-MM-dd'T'HH:mm:ss.SSS'Z'")
        .toFormatter(Locale.ROOT)
        .withResolverStyle(ResolverStyle.STRICT)

internal fun requireCanonicalBase64Url(value: String, name: String) {
    require(base64UrlPattern.matches(value)) { "$name must be canonical unpadded base64url" }
    when (value.length % BASE64_BLOCK_SIZE) {
        1 -> throw IllegalArgumentException("$name must be canonical unpadded base64url")

        BASE64_TWO_CHARACTER_REMAINDER ->
            require(value.last() in "AQgw") { "$name has non-zero trailing pad bits" }

        BASE64_THREE_CHARACTER_REMAINDER ->
            require(value.last() in "AEIMQUYcgkosw048") { "$name has non-zero trailing pad bits" }
    }
}

internal fun requireEncodedBytes(value: String, bytes: Int, name: String) {
    requireCanonicalBase64Url(value, name)
    require(value.length * BASE64_BYTES_PER_FULL_BLOCK / BASE64_BLOCK_SIZE == bytes) {
        "$name must encode $bytes bytes"
    }
}

internal fun encodedByteCount(value: String): Int = value.length * BASE64_BYTES_PER_FULL_BLOCK / BASE64_BLOCK_SIZE

internal fun requireUuidV7(value: String, name: String) {
    require(uuidV7Pattern.matches(value)) { "$name must be a lowercase canonical UUIDv7" }
}

internal fun requireIsoTimestamp(value: String, name: String) {
    require(isoTimestampPattern.matches(value)) { "$name must be a UTC timestamp with milliseconds" }
    try {
        LocalDateTime.parse(value, isoTimestampFormatter)
    } catch (exception: DateTimeParseException) {
        throw IllegalArgumentException("$name must be a valid UTC timestamp", exception)
    }
}

internal fun requireHttpUrl(value: String, name: String) {
    require(value.none { it.isWhitespace() }) { "$name must not contain whitespace" }
    require(httpUrlPrefixPattern.containsMatchIn(value)) { "$name must use HTTP or HTTPS" }
    val url = value.toHttpUrlOrNull()
    require(url != null && url.host.isNotEmpty()) { "$name must be an absolute HTTP(S) URL with a hostname" }
}

internal fun requireTransferUrl(value: String, name: String) {
    if (value.startsWith("/") && !value.startsWith("//") && value.none { it.isWhitespace() }) {
        return
    }
    requireHttpUrl(value, name)
}

internal fun requireByteCount(value: Long, name: String) {
    require(value in 0..MAX_SAFE_INTEGER) { "$name must be a non-negative safe integer" }
}

internal fun requirePositiveInteger(value: Long, name: String) {
    require(value in 1..MAX_SAFE_INTEGER) { "$name must be a positive safe integer" }
}

@Serializable
@JvmInline
value class B64u(val value: String) {
    init {
        requireCanonicalBase64Url(value, "B64u")
    }
}

@Serializable
@JvmInline
value class Uuidv7(val value: String) {
    init {
        requireUuidV7(value, "Uuidv7")
    }
}

@Serializable
@JvmInline
value class IsoTimestamp(val value: String) {
    init {
        requireIsoTimestamp(value, "IsoTimestamp")
    }
}

@Serializable
@JvmInline
value class HttpUrl(val value: String) {
    init {
        requireHttpUrl(value, "HttpUrl")
    }
}

@Serializable
enum class Platform {
    @SerialName("web")
    WEB,

    @SerialName("android")
    ANDROID,

    @SerialName("desktop")
    DESKTOP,

    @SerialName("cli")
    CLI
}

@Serializable
enum class UploadMode {
    @SerialName("auto")
    AUTO,

    @SerialName("direct")
    DIRECT,

    @SerialName("proxy")
    PROXY
}

@Serializable
enum class ErrorCode(val wireValue: String) {
    @SerialName("bad_request")
    BAD_REQUEST("bad_request"),

    @SerialName("unauthorized")
    UNAUTHORIZED("unauthorized"),

    @SerialName("forbidden")
    FORBIDDEN("forbidden"),

    @SerialName("not_found")
    NOT_FOUND("not_found"),

    @SerialName("conflict")
    CONFLICT("conflict"),

    @SerialName("not_initialized")
    NOT_INITIALIZED("not_initialized"),

    @SerialName("gone")
    GONE("gone"),

    @SerialName("payload_too_large")
    PAYLOAD_TOO_LARGE("payload_too_large"),

    @SerialName("rate_limited")
    RATE_LIMITED("rate_limited"),

    @SerialName("internal")
    INTERNAL("internal")
}
