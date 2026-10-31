package dev.pneumo.app.crypto

import dev.pneumo.app.protocol.Envelope
import dev.pneumo.app.protocol.ProtocolJson
import dev.pneumo.app.protocol.PushPayload
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class PushCryptoTest {
    @Test
    fun everyEnvelopeVectorEncryptsAndDecrypts() {
        for (element in CryptoVectorFixture.array("envelope")) {
            val vector = element.asObject()
            val contentKey = deriveKeys(decodeBytes(vector.string("masterKey"))).contentKey
            val payloadElement = vector.getValue("payload")
            val payload = ProtocolJson.decodeFromJsonElement(PushPayload.serializer(), payloadElement)
            val expected = envelope(vector.objectValue("envelope"))

            val actual = PushCrypto.encryptWithNonce(
                contentKey = contentKey,
                pushId = vector.string("pushId"),
                payload = payload,
                nonce = decodeBytes(vector.string("nonce"))
            )

            assertTrue("Envelope version differs", actual.v == expected.v)
            assertTrue("Envelope nonce differs", actual.n == expected.n)
            assertTrue("Envelope ciphertext differs", actual.c == expected.c)
            val decrypted = PushCrypto.decrypt(contentKey, vector.string("pushId"), expected)
            val decryptedElement = ProtocolJson.encodeToJsonElement(PushPayload.serializer(), decrypted)
            assertTrue("Decrypted payload differs", decryptedElement == payloadElement)
        }
    }

    @Test
    fun everyNegativeEnvelopeVectorIsRejected() {
        val envelopeVectors = CryptoVectorFixture.array("envelope")
            .associateBy { it.asObject().string("name") }
        for (element in CryptoVectorFixture.array("negative")) {
            val vector = element.asObject()
            if (vector.string("operation") != "decryptPush") continue
            val source = vector.objectValue("source")
            val positive = requireNotNull(envelopeVectors[source.string("name")]).asObject()
            val mutation = vector.objectValue("mutation")
            val originalEnvelope = positive.objectValue("envelope")
            val pushId: String
            val mutatedEnvelope: Envelope
            when (mutation.string("type")) {
                "xor-last-byte" -> {
                    val ciphertext = decodeBytes(originalEnvelope.string("c"))
                    ciphertext[ciphertext.lastIndex] =
                        (ciphertext.last().toInt() xor mutation.long("xor").toInt()).toByte()
                    mutatedEnvelope = Envelope(
                        v = originalEnvelope.long("v"),
                        n = originalEnvelope.string("n"),
                        c = Base64Url.encode(ciphertext)
                    )
                    pushId = positive.string("pushId")
                }

                "replace-push-id" -> {
                    mutatedEnvelope = envelope(originalEnvelope)
                    pushId = mutation.string("value")
                }

                else -> error("Unknown envelope mutation")
            }
            val contentKey = deriveKeys(decodeBytes(positive.string("masterKey"))).contentKey

            assertThrows(Exception::class.java) {
                PushCrypto.decrypt(contentKey, pushId, mutatedEnvelope)
            }
        }
    }

    @Test
    fun decryptedPayloadIgnoresUnknownFields() {
        val contentKey = deriveKeys(ByteArray(KEY_SIZE_BYTES)).contentKey
        val envelope = encryptRawPayload(
            contentKey,
            PUSH_ID,
            """{"type":"note","body":"fixed body","future":true}"""
        )

        val payload = PushCrypto.decrypt(contentKey, PUSH_ID, envelope)

        val decoded = ProtocolJson.encodeToJsonElement(PushPayload.serializer(), payload).jsonObject
        assertTrue(decoded.getValue("type").jsonPrimitive.content == "note")
        assertTrue(decoded.getValue("body").jsonPrimitive.content == "fixed body")
    }

    @Test
    fun decryptedPayloadStillRequiresRequiredFields() {
        val contentKey = deriveKeys(ByteArray(KEY_SIZE_BYTES)).contentKey
        val envelope = encryptRawPayload(
            contentKey,
            PUSH_ID,
            """{"type":"note","future":true}"""
        )

        assertThrows(Exception::class.java) {
            PushCrypto.decrypt(contentKey, PUSH_ID, envelope)
        }
    }

    private fun encryptRawPayload(contentKey: SecretKey, pushId: String, json: String): Envelope {
        val nonce = ByteArray(NONCE_SIZE_BYTES)
        val cipher = Cipher.getInstance(CIPHER_ALGORITHM)
        cipher.init(Cipher.ENCRYPT_MODE, contentKey, GCMParameterSpec(TAG_SIZE_BITS, nonce))
        cipher.updateAAD((PUSH_AAD_PREFIX + pushId).toByteArray(Charsets.UTF_8))
        val plaintext = json.toByteArray(Charsets.UTF_8)
        return try {
            Envelope(
                v = 1L,
                n = Base64Url.encode(nonce),
                c = Base64Url.encode(cipher.doFinal(plaintext))
            )
        } finally {
            plaintext.fill(0)
        }
    }

    private fun envelope(value: JsonObject): Envelope = Envelope(
        v = value.long("v"),
        n = value.string("n"),
        c = value.string("c")
    )

    private companion object {
        const val PUSH_ID = "0194f5d4-6c20-7a31-9abc-0123456789ac"
        const val PUSH_AAD_PREFIX = "pneumo/v1/push:"
        const val CIPHER_ALGORITHM = "AES/GCM/NoPadding"
        const val KEY_SIZE_BYTES = 32
        const val NONCE_SIZE_BYTES = 12
        const val TAG_SIZE_BITS = 128
    }
}
