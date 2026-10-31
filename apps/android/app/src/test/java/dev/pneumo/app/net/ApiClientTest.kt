package dev.pneumo.app.net

import dev.pneumo.app.protocol.ClaimPairRequest
import dev.pneumo.app.protocol.CreatePushRequest
import dev.pneumo.app.protocol.DeviceInput
import dev.pneumo.app.protocol.Envelope
import dev.pneumo.app.protocol.Platform
import dev.pneumo.app.protocol.ProtocolJson
import dev.pneumo.app.protocol.UpdateDeviceRequest
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ApiClientTest : ApiClientTestSupport() {
    @Test
    fun meUsesBearerAndParsesResponse() = runTest {
        server.enqueue(jsonResponse(ME_RESPONSE))

        val response = client.me()
        val request = server.takeRequest()

        assertEquals(DEVICE_ID, response.device.id)
        assertEquals("/api/me", request.path)
        assertTrue(request.getHeader(AUTHORIZATION) == "Bearer $FIXED_FAKE_BEARER")
    }

    @Test
    fun publicClaimHasNoBearerAndEncodesBody() = runTest {
        server.enqueue(jsonResponse(CLAIM_RESPONSE, HTTP_CREATED))
        val publicClient = ApiClient(server.url("/"))

        publicClient.claimPair(
            ClaimPairRequest(
                code = PAIR_CODE,
                device = DeviceInput(name = "Fixed test phone", platform = Platform.ANDROID)
            )
        )
        val request = server.takeRequest()
        val json = ProtocolJson.parseToJsonElement(request.body.readUtf8()).jsonObject

        assertEquals("/api/pair/claim", request.path)
        assertNull(request.getHeader(AUTHORIZATION))
        assertTrue(json.getValue("code").jsonPrimitive.content == PAIR_CODE)
        assertTrue(
            json.getValue("device").jsonObject.getValue("platform").jsonPrimitive.content == "android"
        )
    }

    @Test
    fun deviceUpdateEncodesBody() = runTest {
        server.enqueue(jsonResponse(DEVICE_RESPONSE))

        client.updateDevice(DEVICE_ID, UpdateDeviceRequest(name = "Renamed phone"))
        val request = server.takeRequest()
        val json = ProtocolJson.parseToJsonElement(request.body.readUtf8()).jsonObject

        assertEquals("/api/devices/$DEVICE_ID", request.path)
        assertEquals("PATCH", request.method)
        assertTrue(json.getValue("name").jsonPrimitive.content == "Renamed phone")
    }

    @Test
    fun createPushEncodesRequiredNulls() = runTest {
        server.enqueue(jsonResponse(PUSH_RESPONSE, HTTP_CREATED))
        val envelope = Envelope(v = PROTOCOL_VERSION, n = NONCE, c = CIPHERTEXT)

        client.createPush(
            CreatePushRequest(
                id = PUSH_ID,
                targetDeviceId = null,
                envelope = envelope,
                file = null
            )
        )
        val request = server.takeRequest()
        val json = ProtocolJson.parseToJsonElement(request.body.readUtf8()).jsonObject

        assertEquals("/api/pushes", request.path)
        assertTrue(json.getValue("targetDeviceId") is JsonNull)
        assertTrue(json.getValue("file") is JsonNull)
        assertTrue(json.getValue("envelope").jsonObject.getValue("n").jsonPrimitive.content == NONCE)
    }

    @Test
    fun listPushesSendsCursorAndValidatedLimit() = runTest {
        server.enqueue(jsonResponse(EMPTY_PUSH_PAGE))

        client.listPushes(before = PUSH_ID, limit = PAGE_LIMIT)
        val request = server.takeRequest()

        assertEquals(PUSH_ID, request.requestUrl?.queryParameter("before"))
        assertEquals(PAGE_LIMIT.toString(), request.requestUrl?.queryParameter("limit"))
    }

    @Test
    fun listPushesSendsDefaultLimit() = runTest {
        server.enqueue(jsonResponse(EMPTY_PUSH_PAGE))

        client.listPushes()
        val request = server.takeRequest()

        assertEquals(DEFAULT_PAGE_LIMIT.toString(), request.requestUrl?.queryParameter("limit"))
        assertNull(request.requestUrl?.queryParameter("before"))
    }
}
