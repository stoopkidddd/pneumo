package dev.pneumo.app.protocol

import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import kotlinx.serialization.KSerializer
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

private const val VALID_FIXTURE_COUNT = 90
private const val INVALID_FIXTURE_COUNT = 111
private const val COERCED_LIMIT = 100L

class ProtocolFixtureTest {
    @Test
    fun everyValidFixtureDecodesAndRoundTrips() {
        val fixtures = fixtures("valid")
        assertEquals(VALID_FIXTURE_COUNT, fixtures.size)

        fixtures.forEach { path ->
            val schemaName = schemaName(path)
            val serializer = requireNotNull(protocolSerializers[schemaName])
            val source = Files.readString(path)
            val expected = ProtocolJson.parseToJsonElement(source)
            val actual = roundTrip(serializer, source)
            assertTrue(path.fileName.toString(), expected == actual)
        }
    }

    @Test
    fun everyInvalidFixtureFailsItsModelSerializer() {
        val fixtures = fixtures("invalid")
        assertEquals(INVALID_FIXTURE_COUNT, fixtures.size)

        fixtures.forEach { path ->
            val schemaName = schemaName(path)
            val serializer = requireNotNull(protocolSerializers[schemaName])
            val source = Files.readString(path)
            expectFailure(path.fileName.toString()) {
                decode(serializer, source)
            }
        }
    }

    @Test
    fun listQueryCoercesStringNumbersAndOmitsDefault() {
        val query = ProtocolJson.decodeFromString(ListPushesQuery.serializer(), """{"limit":"50"}""")
        assertEquals(DEFAULT_PUSH_LIMIT, query.limit)
        assertEquals(JsonObject(emptyMap()), ProtocolJson.encodeToJsonElement(ListPushesQuery.serializer(), query))

        val exponent = ProtocolJson.decodeFromString(ListPushesQuery.serializer(), """{"limit":"1e2"}""")
        assertEquals(COERCED_LIMIT, exponent.limit)
        assertEquals(
            JsonObject(mapOf("limit" to JsonPrimitive(COERCED_LIMIT))),
            ProtocolJson.encodeToJsonElement(ListPushesQuery.serializer(), exponent)
        )
    }

    private fun fixtures(kind: String): List<Path> {
        val resourceName = "protocol/fixtures/$kind"
        val resource = requireNotNull(javaClass.classLoader?.getResource(resourceName)) {
            "Missing generated fixture directory $resourceName"
        }
        return Files.list(Paths.get(resource.toURI())).use { paths ->
            paths.filter { it.fileName.toString().endsWith(".json") }
                .sorted()
                .iterator()
                .asSequence()
                .toList()
        }
    }

    private fun schemaName(path: Path): String = path.fileName.toString()
        .substringBefore("--")
        .substringBefore(".json")

    private fun <T> roundTrip(serializer: KSerializer<T>, source: String): JsonElement {
        val decoded = ProtocolJson.decodeFromString(serializer, source)
        return ProtocolJson.parseToJsonElement(ProtocolJson.encodeToString(serializer, decoded))
    }

    private fun <T> decode(serializer: KSerializer<T>, source: String) {
        ProtocolJson.decodeFromString(serializer, source)
    }

    private fun expectFailure(name: String, block: () -> Unit) {
        assertThrows(name, Exception::class.java) { block() }
    }
}

private val protocolSerializers: Map<String, KSerializer<out Any>> = mapOf(
    "B64u" to B64u.serializer(),
    "Uuidv7" to Uuidv7.serializer(),
    "IsoTimestamp" to IsoTimestamp.serializer(),
    "HttpUrl" to HttpUrl.serializer(),
    "KdfParams" to KdfParams.serializer(),
    "Envelope" to Envelope.serializer(),
    "NotePayload" to NotePayload.serializer(),
    "LinkPayload" to LinkPayload.serializer(),
    "FilePayload" to FilePayload.serializer(),
    "PushPayload" to PushPayload.serializer(),
    "Platform" to Platform.serializer(),
    "WebPushSubscription" to WebPushSubscription.serializer(),
    "DeviceInput" to DeviceInput.serializer(),
    "DeviceRecord" to DeviceRecord.serializer(),
    "DeviceDTO" to DeviceDTO.serializer(),
    "PushRecord" to PushRecord.serializer(),
    "PushDTO" to PushDTO.serializer(),
    "WebPushPayload" to WebPushPayload.serializer(),
    "Limits" to Limits.serializer(),
    "UploadMode" to UploadMode.serializer(),
    "ErrorCode" to ErrorCode.serializer(),
    "ErrorBody" to ErrorBody.serializer(),
    "HealthResponse" to HealthResponse.serializer(),
    "SetupRequest" to SetupRequest.serializer(),
    "SetupResponse" to SetupResponse.serializer(),
    "AuthParamsResponse" to AuthParamsResponse.serializer(),
    "LoginRequest" to LoginRequest.serializer(),
    "LoginResponse" to LoginResponse.serializer(),
    "MeResponse" to MeResponse.serializer(),
    "ListDevicesResponse" to ListDevicesResponse.serializer(),
    "UpdateDeviceRequest" to UpdateDeviceRequest.serializer(),
    "SubscribeWebPushRequest" to SubscribeWebPushRequest.serializer(),
    "CreatePairResponse" to CreatePairResponse.serializer(),
    "ClaimPairRequest" to ClaimPairRequest.serializer(),
    "ClaimPairResponse" to ClaimPairResponse.serializer(),
    "CreateFileRequest" to CreateFileRequest.serializer(),
    "CreateFileResponse" to CreateFileResponse.serializer(),
    "GetFileResponse" to GetFileResponse.serializer(),
    "CreatePushRequest" to CreatePushRequest.serializer(),
    "ListPushesQuery" to ListPushesQuery.serializer(),
    "ListPushesResponse" to ListPushesResponse.serializer(),
    "HelloFrame" to HelloFrame.serializer(),
    "PongFrame" to PongFrame.serializer(),
    "ClientFrame" to ClientFrame.serializer(),
    "ReadyFrame" to ReadyFrame.serializer(),
    "PushFrame" to PushFrame.serializer(),
    "PushDeletedFrame" to PushDeletedFrame.serializer(),
    "DeviceAddedFrame" to DeviceAddedFrame.serializer(),
    "DeviceUpdatedFrame" to DeviceUpdatedFrame.serializer(),
    "DeviceRemovedFrame" to DeviceRemovedFrame.serializer(),
    "ReplayDoneFrame" to ReplayDoneFrame.serializer(),
    "ResyncFrame" to ResyncFrame.serializer(),
    "PingFrame" to PingFrame.serializer(),
    "ServerFrame" to ServerFrame.serializer()
)
