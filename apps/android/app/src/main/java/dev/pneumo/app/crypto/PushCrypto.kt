package dev.pneumo.app.crypto

import dev.pneumo.app.protocol.Envelope
import dev.pneumo.app.protocol.ProtocolJson
import dev.pneumo.app.protocol.PushPayload
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

object PushCrypto {
    fun encrypt(contentKey: SecretKey, pushId: String, payload: PushPayload): Envelope {
        val nonce = ByteArray(NONCE_SIZE_BYTES)
        secureRandom.nextBytes(nonce)
        return encryptWithNonce(contentKey, pushId, payload, nonce)
    }

    internal fun encryptWithNonce(
        contentKey: SecretKey,
        pushId: String,
        payload: PushPayload,
        nonce: ByteArray
    ): Envelope {
        require(nonce.size == NONCE_SIZE_BYTES) { "Expected a 12-byte nonce" }
        val plaintext = ProtocolJson
            .encodeToString(PushPayload.serializer(), payload)
            .toByteArray(Charsets.UTF_8)
        return try {
            val cipher = newCipher(Cipher.ENCRYPT_MODE, contentKey, nonce, pushId)
            val ciphertext = cipher.doFinal(plaintext)
            Envelope(
                v = ENVELOPE_VERSION,
                n = Base64Url.encode(nonce),
                c = Base64Url.encode(ciphertext)
            )
        } finally {
            plaintext.fill(0)
        }
    }

    fun decrypt(contentKey: SecretKey, pushId: String, envelope: Envelope): PushPayload {
        require(envelope.v == ENVELOPE_VERSION) { "Unsupported envelope version" }
        val nonce = Base64Url.decode(envelope.n)
        require(nonce.size == NONCE_SIZE_BYTES) { "Expected a 12-byte nonce" }
        val ciphertext = Base64Url.decode(envelope.c)
        require(ciphertext.size >= TAG_SIZE_BYTES) { "Envelope ciphertext is too short" }
        val cipher = newCipher(Cipher.DECRYPT_MODE, contentKey, nonce, pushId)
        val plaintext = cipher.doFinal(ciphertext)
        return try {
            val decoded = Charsets.UTF_8
                .newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(plaintext))
                .toString()
            ProtocolJson.decodeFromString(PushPayload.serializer(), decoded)
        } finally {
            plaintext.fill(0)
        }
    }

    private fun newCipher(mode: Int, contentKey: SecretKey, nonce: ByteArray, pushId: String): Cipher =
        Cipher.getInstance(CIPHER_ALGORITHM).apply {
            init(mode, contentKey, GCMParameterSpec(TAG_SIZE_BITS, nonce))
            updateAAD((PUSH_AAD_PREFIX + pushId).toByteArray(Charsets.UTF_8))
        }

    private val secureRandom = SecureRandom()
    private const val CIPHER_ALGORITHM = "AES/GCM/NoPadding"
    private const val PUSH_AAD_PREFIX = "pneumo/v1/push:"
    private const val NONCE_SIZE_BYTES = 12
    private const val TAG_SIZE_BYTES = 16
    private const val TAG_SIZE_BITS = 128
    private const val ENVELOPE_VERSION = 1L
}
