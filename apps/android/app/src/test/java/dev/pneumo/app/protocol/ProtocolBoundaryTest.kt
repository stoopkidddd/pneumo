package dev.pneumo.app.protocol

import kotlinx.serialization.decodeFromString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

private const val VALID_ID = "019a36f0-7b00-7000-8000-000000000001"
private const val VALID_TIME = "2026-10-30T12:00:00.000Z"
private const val FAKE_CREDENTIAL = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

class ProtocolBoundaryTest {
    @Test
    fun requiredNullableFieldsAcceptNullButRejectAbsence() {
        val push = ProtocolJson.decodeFromString(PushDTO.serializer(), pushJson(targetAndFile = true))
        assertNull(push.targetDeviceId)
        assertNull(push.file)

        expectFailure { ProtocolJson.decodeFromString(PushDTO.serializer(), pushJson(targetAndFile = false)) }
        expectFailure {
            ProtocolJson.decodeFromString(
                HelloFrame.serializer(),
                """{"type":"hello","token":"$FAKE_CREDENTIAL","client":{"platform":"android","version":"0.1.0"}}"""
            )
        }
        expectFailure {
            ProtocolJson.decodeFromString(ListPushesResponse.serializer(), """{"pushes":[]}""")
        }
    }

    @Test
    fun optionalPayloadStringsAcceptAbsenceButRejectExplicitNull() {
        val note = ProtocolJson.decodeFromString(NotePayload.serializer(), """{"type":"note","body":"fixed text"}""")
        assertNull(note.title)

        expectFailure {
            ProtocolJson.decodeFromString(
                NotePayload.serializer(),
                """{"type":"note","title":null,"body":"fixed text"}"""
            )
        }
        expectFailure {
            ProtocolJson.decodeFromString(
                LinkPayload.serializer(),
                """{"type":"link","body":null,"url":"https://example.test"}"""
            )
        }
        expectFailure {
            ProtocolJson.decodeFromString(
                FilePayload.serializer(),
                """{"type":"file","title":null,"file":{
                    |"name":"a.txt","mime":"text/plain","size":1,"key":"$FAKE_CREDENTIAL"}}
                """.trimMargin()
            )
        }
    }

    @Test
    fun base64UrlRequiresCanonicalAlphabetAndTrailingBits() {
        assertEquals("AA", ProtocolJson.decodeFromString(B64u.serializer(), "\"AA\"").value)
        expectFailure { ProtocolJson.decodeFromString(B64u.serializer(), "\"AB\"") }
        expectFailure { ProtocolJson.decodeFromString(B64u.serializer(), "\"AAB\"") }
        expectFailure { ProtocolJson.decodeFromString(B64u.serializer(), "\"AA==\"") }
    }

    @Test
    fun timestampRequiresRealUtcMillisecondDate() {
        assertEquals(VALID_TIME, ProtocolJson.decodeFromString(IsoTimestamp.serializer(), "\"$VALID_TIME\"").value)
        expectFailure {
            ProtocolJson.decodeFromString(IsoTimestamp.serializer(), "\"2026-02-30T12:00:00.000Z\"")
        }
        expectFailure {
            ProtocolJson.decodeFromString(IsoTimestamp.serializer(), "\"2026-10-30T12:00:00.00Z\"")
        }
        expectFailure {
            ProtocolJson.decodeFromString(IsoTimestamp.serializer(), "\"2026-10-30T12:00:00.000+00:00\"")
        }
    }

    @Test
    fun explicitNullOptionalQueryAndMissingConcreteDiscriminatorFail() {
        expectFailure { ProtocolJson.decodeFromString(ListPushesQuery.serializer(), """{"before":null}""") }
        expectFailure { ProtocolJson.decodeFromString(PongFrame.serializer(), "{}") }
    }

    @Test
    fun unknownFieldsAreIgnoredAtEveryPayloadLevel() {
        val payload = ProtocolJson.decodeFromString(
            PushPayload.serializer(),
            """{"type":"file","future":true,"file":{
                |"name":"a.txt","mime":"text/plain","size":1,"key":"$FAKE_CREDENTIAL","futureNested":true}}
            """.trimMargin()
        )
        val filePayload = payload as FilePayload
        assertEquals("a.txt", filePayload.file.name)
    }

    @Test
    fun sensitiveModelsDoNotRevealValuesThroughToString() {
        val payload = NotePayload(body = "fixed plaintext")
        val hello = HelloFrame("hello", FAKE_CREDENTIAL, null, ClientInfo(Platform.ANDROID, "0.1.0"))
        assertFalse(payload.toString().contains("fixed plaintext"))
        assertFalse(hello.toString().contains(FAKE_CREDENTIAL))
    }

    private fun pushJson(targetAndFile: Boolean): String {
        val nullableFields = if (targetAndFile) ""","targetDeviceId":null,"file":null""" else ""
        return """{"id":"$VALID_ID","createdAt":"$VALID_TIME","sourceDeviceId":"$VALID_ID",
            |"envelope":{"v":1,"n":"AAAAAAAAAAAAAAAA","c":"AAAAAAAAAAAAAAAAAAAAAA"}$nullableFields}
        """.trimMargin()
    }

    private fun expectFailure(block: () -> Unit) {
        assertThrows(Exception::class.java) { block() }
    }
}
