package dev.pneumo.app.net

import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ApiClientErrorTest : ApiClientTestSupport() {
    @Test
    fun mapsTypedErrorsAndUsesSafeMalformedFallback() = runTest {
        server.enqueue(
            jsonResponse(
                """{"error":{"code":"not_found","message":"Push does not exist"}}""",
                HTTP_NOT_FOUND
            )
        )
        val typed = expectApiError { client.getPush(PUSH_ID) }

        assertEquals("not_found", typed.code)
        assertEquals(HTTP_NOT_FOUND, typed.status)
        assertEquals("Push does not exist", typed.message)

        server.enqueue(
            MockResponse()
                .setResponseCode(HTTP_INTERNAL_ERROR)
                .setBody(MALFORMED_SENSITIVE_RESPONSE)
        )
        val malformed = expectApiError { client.me() }

        assertEquals("http_error", malformed.code)
        assertEquals(HTTP_INTERNAL_ERROR, malformed.status)
        assertFalse(malformed.message.orEmpty().contains(MALFORMED_SENSITIVE_RESPONSE))
    }

    @Test
    fun everyUnauthorizedResponseUsesUnauthorizedSubtype() = runTest {
        server.enqueue(
            MockResponse()
                .setResponseCode(HTTP_UNAUTHORIZED)
                .setBody("not-json")
        )

        val error = expectApiError { client.listDevices() }

        assertTrue(error is ApiError.Unauthorized)
        assertEquals(HTTP_UNAUTHORIZED, error.status)
        assertEquals("unauthorized", error.code)
    }

    private suspend fun expectApiError(block: suspend () -> Unit): ApiError {
        try {
            block()
        } catch (error: ApiError) {
            return error
        }
        throw AssertionError("Expected ApiError")
    }
}
