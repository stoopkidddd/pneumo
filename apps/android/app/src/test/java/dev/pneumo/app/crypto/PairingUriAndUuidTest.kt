package dev.pneumo.app.crypto

import java.net.URLEncoder
import java.security.SecureRandom
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class PairingUriAndUuidTest {
    private val mk = ByteArray(MASTER_KEY_SIZE_BYTES) { it.toByte() }
    private val code = Base64Url.encode(ByteArray(PAIRING_CODE_SIZE_BYTES) { (PAIRING_CODE_SEED - it).toByte() })

    @Test
    fun exactHttpAndHttpsOriginsRoundTrip() {
        for (origin in validOrigins) {
            val uri = PairingUri.build(PairingData(origin, code, mk))

            assertTrue(uri.startsWith(PAIRING_PREFIX))
            val parsed = PairingUri.parse(uri)
            assertTrue(parsed.origin == origin)
            assertTrue(parsed.code == code)
            assertSecretEquals(mk, parsed.mk)
        }
    }

    @Test
    fun malformedUriStructuresAreRejected() {
        val valid = PairingUri.build(ORIGIN, code, mk)
        val invalid = listOf(
            valid.replace(PAIRING_PREFIX, "https://pair?"),
            valid.replace(PAIRING_PREFIX, "pneumo://other?"),
            valid.replace("pneumo://", "pneumo:"),
            valid.replace("pneumo://", "PNEUMO://"),
            valid.replace("pneumo://pair", "pneumo://user:pass@pair"),
            valid.replace(PAIRING_PREFIX, "pneumo://pair/path?"),
            "$valid#fragment",
            "$valid "
        )

        for (uri in invalid) assertParseRejects(uri)
        val malformedWithKey = "$valid%"
        val failure = assertThrows(IllegalArgumentException::class.java) {
            PairingUri.parse(malformedWithKey)
        }
        assertTrue(failure.message == "Invalid pairing URI")
    }

    @Test
    fun parametersMustBeExactUniqueAndVersionOne() {
        for (missing in requiredFields) {
            val fields = validFields().filterKeys { it != missing }
            assertParseRejects(pairingUri(fields))
        }
        for (duplicate in requiredFields) {
            assertParseRejects("${pairingUri(validFields())}&$duplicate=1")
        }
        assertParseRejects("${pairingUri(validFields())}&x=unexpected")
        for (version in listOf("", "0", "2", "01")) {
            assertParseRejects(pairingUri(validFields() + ("v" to version)))
        }
    }

    @Test
    fun keysAndCodesMustBeCanonicalAndExactLength() {
        val key = Base64Url.encode(mk)
        val invalidKeys = listOf(
            key.dropLast(1) + "*",
            "$key=",
            key.dropLast(1) + "B",
            Base64Url.encode(ByteArray(MASTER_KEY_SIZE_BYTES - 1)),
            Base64Url.encode(ByteArray(MASTER_KEY_SIZE_BYTES + 1)),
            ""
        )
        for (invalid in invalidKeys) {
            assertParseRejects(pairingUri(validFields() + ("k" to invalid)))
        }

        val invalidCodes = listOf(
            code.dropLast(1) + "*",
            "$code=",
            code.dropLast(1) + "B",
            Base64Url.encode(ByteArray(PAIRING_CODE_SIZE_BYTES - 1)),
            Base64Url.encode(ByteArray(PAIRING_CODE_SIZE_BYTES + 1)),
            ""
        )
        for (invalid in invalidCodes) {
            assertParseRejects(pairingUri(validFields() + ("c" to invalid)))
            assertThrows(Exception::class.java) { PairingUri.build(ORIGIN, invalid, mk) }
        }
    }

    @Test
    fun originsMustBeCanonicalHttpOrigins() {
        val invalidOrigins = listOf(
            "ftp://example.test",
            "https://user:password@example.test",
            "https://example.test/path",
            "https://example.test?query=value",
            "https://example.test#fragment",
            "https://example.test/",
            "https://EXAMPLE.test",
            "https://example.test:443",
            "/server"
        )
        for (invalid in invalidOrigins) {
            assertParseRejects(pairingUri(validFields() + ("u" to invalid)))
            assertThrows(Exception::class.java) { PairingUri.build(invalid, code, mk) }
        }
    }

    @Test
    fun builderRejectsEveryPlausibleWrongMasterKeyLength() {
        for (length in wrongMasterKeyLengths) {
            assertThrows(Exception::class.java) {
                PairingUri.build(ORIGIN, code, ByteArray(length))
            }
        }
    }

    @Test
    fun uuidVersionSevenUsesTimestampVersionAndVariantAtBoundaries() {
        val zero = Uuidv7.generate(0, FixedSecureRandom())
        val maximum = Uuidv7.generate(MAX_UUID_TIMESTAMP, FixedSecureRandom())

        assertTrue(zero.startsWith("00000000-0000-7"))
        assertTrue(maximum.startsWith("ffffffff-ffff-7"))
        assertTrue(Uuidv7.isValid(zero))
        assertTrue(Uuidv7.isValid(maximum))
        assertTrue(zero[VARIANT_OFFSET] in "89ab")
        assertTrue(maximum[VARIANT_OFFSET] in "89ab")
    }

    @Test
    fun uuidVersionSevenRejectsOutOfRangeTimestampsAndNoncanonicalIds() {
        assertThrows(IllegalArgumentException::class.java) {
            Uuidv7.generate(-1, FixedSecureRandom())
        }
        assertThrows(IllegalArgumentException::class.java) {
            Uuidv7.generate(MAX_UUID_TIMESTAMP + 1, FixedSecureRandom())
        }
        assertFalse(Uuidv7.isValid("0194F5D4-6C20-7A31-9ABC-0123456789AC"))
        assertFalse(Uuidv7.isValid("0194f5d4-6c20-6a31-9abc-0123456789ac"))
        assertFalse(Uuidv7.isValid("0194f5d4-6c20-7a31-7abc-0123456789ac"))
        assertFalse(Uuidv7.isValid("not-a-uuid"))
    }

    private fun assertParseRejects(uri: String) {
        assertThrows(Exception::class.java) { PairingUri.parse(uri) }
    }

    private fun validFields(): Map<String, String> = linkedMapOf(
        "v" to "1",
        "u" to ORIGIN,
        "c" to code,
        "k" to Base64Url.encode(mk)
    )

    private fun pairingUri(fields: Map<String, String>): String =
        fields.entries.joinToString(prefix = PAIRING_PREFIX, separator = "&") { (name, value) ->
            "$name=${URLEncoder.encode(value, Charsets.UTF_8.name())}"
        }

    private class FixedSecureRandom : SecureRandom() {
        override fun nextBytes(bytes: ByteArray) {
            bytes.fill(randomByte)
        }
    }

    private companion object {
        val validOrigins = listOf(
            "https://example.test",
            "https://example.test:8443",
            "http://localhost:3000",
            "http://127.0.0.1",
            "https://[2001:db8::1]:9443"
        )
        val requiredFields = listOf("v", "u", "c", "k")
        val wrongMasterKeyLengths =
            intArrayOf(
                0,
                1,
                MASTER_KEY_SIZE_BYTES / 2 - 1,
                MASTER_KEY_SIZE_BYTES - 1,
                MASTER_KEY_SIZE_BYTES + 1
            )
        const val ORIGIN = "https://example.test:8443"
        const val PAIRING_PREFIX = "pneumo://pair?"
        const val MASTER_KEY_SIZE_BYTES = 32
        const val PAIRING_CODE_SIZE_BYTES = 16
        const val PAIRING_CODE_SEED = 0xf0
        const val MAX_UUID_TIMESTAMP = 0xffff_ffff_ffffL
        const val VARIANT_OFFSET = 19
        val randomByte: Byte = RANDOM_BYTE_UNSIGNED.toByte()
        const val RANDOM_BYTE_UNSIGNED = 0xab
    }
}
