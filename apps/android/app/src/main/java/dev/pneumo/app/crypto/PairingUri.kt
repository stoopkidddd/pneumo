package dev.pneumo.app.crypto

import java.net.URI
import java.net.URISyntaxException
import java.net.URLDecoder
import java.net.URLEncoder
import java.util.Locale

class PairingData(val origin: String, val code: String, mk: ByteArray) {
    private val mkBytes = mk.copyOf()

    val mk: ByteArray
        get() = mkBytes.copyOf()
}

object PairingUri {
    fun build(data: PairingData): String = build(data.origin, data.code, data.mk)

    fun build(origin: String, code: String, mk: ByteArray): String {
        validateOrigin(origin)
        validateEncodedLength(code, PAIRING_CODE_SIZE_BYTES, "pairing code")
        require(mk.size == MASTER_KEY_SIZE_BYTES) { "Expected a 32-byte master key" }
        return buildString {
            append(PREFIX)
            append("v=1&u=")
            append(encodeQueryComponent(origin))
            append("&c=")
            append(encodeQueryComponent(code))
            append("&k=")
            append(encodeQueryComponent(Base64Url.encode(mk)))
        }
    }

    fun parse(value: String): PairingData {
        require(value.startsWith(PREFIX)) { "Invalid pairing URI" }
        require(value.none { it.isWhitespace() } && '#' !in value) { "Invalid pairing URI" }
        val uri = parseUri(value, "Invalid pairing URI")
        require(uri.scheme == SCHEME) { "Invalid pairing URI scheme" }
        require(uri.rawAuthority == HOST && uri.host == HOST) { "Invalid pairing URI host" }
        require(uri.userInfo == null && uri.port == NO_PORT) { "Invalid pairing URI authority" }
        require(uri.rawPath.isNullOrEmpty() && uri.rawFragment == null) { "Invalid pairing URI" }
        val fields = parseQuery(uri.rawQuery)
        require(fields.keys == requiredFields) { "Invalid pairing parameters" }
        require(fields.getValue(VERSION_FIELD) == VERSION) { "Unsupported pairing version" }

        val origin = fields.getValue(ORIGIN_FIELD)
        val code = fields.getValue(CODE_FIELD)
        validateOrigin(origin)
        validateEncodedLength(code, PAIRING_CODE_SIZE_BYTES, "pairing code")
        val masterKey = Base64Url.decode(fields.getValue(KEY_FIELD))
        return try {
            require(masterKey.size == MASTER_KEY_SIZE_BYTES) { "Expected a 32-byte master key" }
            PairingData(origin, code, masterKey)
        } finally {
            masterKey.fill(0)
        }
    }

    private fun parseQuery(rawQuery: String?): Map<String, String> {
        require(rawQuery != null) { "Missing pairing parameters" }
        val fields = linkedMapOf<String, String>()
        for (part in rawQuery.split('&')) {
            val separator = part.indexOf('=')
            val rawName = if (separator < 0) part else part.substring(0, separator)
            val rawValue = if (separator < 0) "" else part.substring(separator + 1)
            val name = decodeQueryComponent(rawName)
            require(name !in fields) { "Duplicate pairing parameter" }
            fields[name] = decodeQueryComponent(rawValue)
        }
        return fields
    }

    private fun validateOrigin(origin: String) {
        val parsed = parseUri(origin, "Invalid server origin")
        require(parsed.scheme == HTTP_SCHEME || parsed.scheme == HTTPS_SCHEME) {
            "Expected an HTTP(S) origin"
        }
        require(parsed.userInfo == null && parsed.host != null) { "Invalid server origin" }
        require(parsed.rawPath.isNullOrEmpty()) { "Expected an origin without a path" }
        require(parsed.rawQuery == null && parsed.rawFragment == null) { "Expected an exact origin" }
        require(parsed.port in NO_PORT..MAX_PORT) { "Invalid server port" }
        require(parsed.port != defaultPort(parsed.scheme)) { "Explicit default ports are not canonical" }
        val canonicalHost = parsed.host.lowercase(Locale.ROOT)
        val canonical = buildString {
            append(parsed.scheme)
            append("://")
            append(canonicalHost)
            if (parsed.port != NO_PORT) {
                append(':')
                append(parsed.port)
            }
        }
        require(origin == canonical) { "Expected a canonical HTTP(S) origin" }
    }

    private fun validateEncodedLength(value: String, expectedSize: Int, name: String) {
        val decoded = Base64Url.decode(value)
        try {
            require(decoded.size == expectedSize) { "Invalid $name" }
        } finally {
            decoded.fill(0)
        }
    }

    private fun defaultPort(scheme: String): Int = if (scheme == HTTP_SCHEME) HTTP_PORT else HTTPS_PORT

    private fun encodeQueryComponent(value: String): String = URLEncoder.encode(value, Charsets.UTF_8.name())

    private fun decodeQueryComponent(value: String): String = try {
        URLDecoder.decode(value, Charsets.UTF_8.name())
    } catch (_: IllegalArgumentException) {
        throw IllegalArgumentException("Invalid pairing parameter encoding")
    }

    private fun parseUri(value: String, errorMessage: String): URI = try {
        URI(value)
    } catch (_: URISyntaxException) {
        throw IllegalArgumentException(errorMessage)
    }

    private const val SCHEME = "pneumo"
    private const val HOST = "pair"
    private const val PREFIX = "pneumo://pair?"
    private const val HTTP_SCHEME = "http"
    private const val HTTPS_SCHEME = "https"
    private const val HTTP_PORT = 80
    private const val HTTPS_PORT = 443
    private const val MAX_PORT = 65_535
    private const val NO_PORT = -1
    private const val PAIRING_CODE_SIZE_BYTES = 16
    private const val MASTER_KEY_SIZE_BYTES = 32
    private const val VERSION_FIELD = "v"
    private const val ORIGIN_FIELD = "u"
    private const val CODE_FIELD = "c"
    private const val KEY_FIELD = "k"
    private const val VERSION = "1"
    private val requiredFields = setOf(VERSION_FIELD, ORIGIN_FIELD, CODE_FIELD, KEY_FIELD)
}
