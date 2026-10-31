package dev.pneumo.app.net

import dev.pneumo.app.protocol.DownloadTarget
import dev.pneumo.app.protocol.UploadTarget
import kotlinx.coroutines.test.runTest
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ApiClientTransferTest : ApiClientTestSupport() {
    @Test
    fun proxyUploadAndDownloadStreamBytesWithBearer() = runTest {
        server.enqueue(MockResponse().setResponseCode(HTTP_NO_CONTENT))
        server.enqueue(MockResponse().setResponseCode(HTTP_OK).setBody(DOWNLOAD_TEXT))

        client.uploadFileContent(FILE_ID, UPLOAD_BYTES.toRequestBody(OCTET_STREAM))
        val downloaded = client.downloadFileContent(FILE_ID).use { it.bytes() }
        val uploadRequest = server.takeRequest()
        val downloadRequest = server.takeRequest()

        assertEquals("/api/files/$FILE_ID/content", uploadRequest.path)
        assertEquals("PUT", uploadRequest.method)
        assertTrue(uploadRequest.getHeader(AUTHORIZATION) == "Bearer $FIXED_FAKE_BEARER")
        assertTrue(uploadRequest.body.readByteArray().contentEquals(UPLOAD_BYTES))
        assertEquals("/api/files/$FILE_ID/content", downloadRequest.path)
        assertTrue(downloadRequest.getHeader(AUTHORIZATION) == "Bearer $FIXED_FAKE_BEARER")
        assertTrue(downloaded.contentEquals(DOWNLOAD_BYTES))
    }

    @Test
    fun externalTransfersNeverReceiveBearer() = runTest {
        server.enqueue(MockResponse().setResponseCode(HTTP_OK))
        val target =
            UploadTarget(
                method = "PUT",
                url = server.url("/external-upload").toString(),
                headers = mapOf("x-fixed-test" to "value")
            )

        client.uploadTo(target, UPLOAD_BYTES.toRequestBody(OCTET_STREAM))
        val request = server.takeRequest()

        assertEquals("/external-upload", request.path)
        assertNull(request.getHeader(AUTHORIZATION))
        assertEquals("value", request.getHeader("x-fixed-test"))
    }

    @Test
    fun transferRedirectIsNotFollowed() = runTest {
        val redirectTarget = MockWebServer()
        redirectTarget.start()
        try {
            server.enqueue(
                MockResponse()
                    .setResponseCode(HTTP_TEMPORARY_REDIRECT)
                    .setHeader("Location", redirectTarget.url("/must-not-receive-request"))
            )
            val target = DownloadTarget(url = server.url("/redirect").toString(), headers = emptyMap())

            val error = expectApiError { client.downloadFrom(target).close() }

            assertEquals(HTTP_TEMPORARY_REDIRECT, error.status)
            assertEquals(0, redirectTarget.requestCount)
        } finally {
            redirectTarget.shutdown()
        }
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
