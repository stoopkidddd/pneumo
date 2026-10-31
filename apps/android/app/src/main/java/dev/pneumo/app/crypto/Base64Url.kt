package dev.pneumo.app.crypto

import java.util.Base64

internal object Base64Url {
    private val pattern = Regex("^[A-Za-z0-9_-]*$")

    fun encode(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

    fun decode(value: String): ByteArray {
        require(pattern.matches(value)) { "Invalid base64url value" }
        require(value.length % BASE64_QUANTUM != INVALID_REMAINDER) { "Invalid base64url length" }
        val decoded = try {
            Base64.getUrlDecoder().decode(value)
        } catch (_: IllegalArgumentException) {
            throw IllegalArgumentException("Invalid base64url value")
        }
        require(encode(decoded) == value) { "Noncanonical base64url value" }
        return decoded
    }

    private const val BASE64_QUANTUM = 4
    private const val INVALID_REMAINDER = 1
}
