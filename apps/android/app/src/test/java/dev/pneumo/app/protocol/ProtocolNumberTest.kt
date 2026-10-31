package dev.pneumo.app.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class ProtocolNumberTest {
    @Test
    fun byteCountsRequireJsonNumbersRatherThanCoercibleStrings() {
        listOf("\"1\"", "true", "null", "1.5", "9007199254740992").forEach { value ->
            assertThrows("Invalid byte count must fail", Exception::class.java) {
                ProtocolJson.decodeFromString(CreateFileRequest.serializer(), """{"size":$value}""")
            }
        }
    }

    @Test
    fun numericFieldsRetainExactJsonIntegerSemantics() {
        listOf("1", "1.0", "1e0").forEach { value ->
            val decoded = ProtocolJson.decodeFromString(CreateFileRequest.serializer(), """{"size":$value}""")
            assertEquals(1L, decoded.size)
        }
    }

    @Test
    fun versionKdfAndPayloadSizesAlsoRejectQuotedNumbers() {
        assertThrows(Exception::class.java) {
            ProtocolJson.decodeFromString(
                Envelope.serializer(),
                """{"v":"1","n":"AAAAAAAAAAAAAAAA","c":"AAAAAAAAAAAAAAAAAAAAAA"}"""
            )
        }
        assertThrows(Exception::class.java) {
            ProtocolJson.decodeFromString(
                KdfParams.serializer(),
                """{"alg":"PBKDF2-SHA256","iterations":"1000","salt":"AAAAAAAAAAAAAAAAAAAAAA"}"""
            )
        }
        assertThrows(Exception::class.java) {
            ProtocolJson.decodeFromString(
                PayloadFile.serializer(),
                """{"name":"fixed","mime":"text/plain","size":"1",
                    |"key":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}
                """.trimMargin()
            )
        }
    }
}
