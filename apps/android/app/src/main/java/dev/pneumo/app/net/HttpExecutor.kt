package dev.pneumo.app.net

import dev.pneumo.app.protocol.ErrorBody
import dev.pneumo.app.protocol.ProtocolJson
import java.io.IOException
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.DeserializationStrategy
import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody

internal class HttpExecutor(client: OkHttpClient) {
    private val httpClient =
        client.newBuilder()
            .followRedirects(false)
            .followSslRedirects(false)
            .build()

    suspend fun <T> json(
        request: Request,
        deserializer: DeserializationStrategy<T>,
        expectedStatus: Int,
        alternateStatus: Int? = null
    ): T = withContext(Dispatchers.IO) {
        val response = httpClient.newCall(request).await()
        response.use {
            ensureStatus(response, expectedStatus, alternateStatus)
            val body = response.body?.string() ?: throw IOException(MISSING_RESPONSE_MESSAGE)
            return@withContext try {
                ProtocolJson.decodeFromString(deserializer, body)
            } catch (ignored: IllegalArgumentException) {
                throw IOException(MALFORMED_RESPONSE_MESSAGE)
            }
        }
    }

    suspend fun empty(request: Request, expectedStatus: Int): Unit = withContext(Dispatchers.IO) {
        val response = httpClient.newCall(request).await()
        response.use { ensureStatus(response, expectedStatus) }
    }

    suspend fun stream(request: Request, expectedStatus: Int): ResponseBody {
        val response = httpClient.newCall(request).await()
        if (response.code != expectedStatus) {
            response.use { withContext(Dispatchers.IO) { throwApiError(response) } }
        }
        return responseBody(response)
    }

    suspend fun transfer(request: Request): ResponseBody {
        val response = httpClient.newCall(request).await()
        if (!response.isSuccessful) {
            response.use { withContext(Dispatchers.IO) { throwApiError(response) } }
        }
        return responseBody(response)
    }

    private fun ensureStatus(response: Response, expectedStatus: Int, alternateStatus: Int? = null) {
        if (response.code != expectedStatus && response.code != alternateStatus) {
            throwApiError(response)
        }
    }

    private fun throwApiError(response: Response): Nothing {
        val parsed = parseError(response)
        val message = parsed?.error?.message ?: "Request failed with HTTP ${response.code}"
        if (response.code == ApiError.HTTP_UNAUTHORIZED) {
            throw ApiError.Unauthorized(message)
        }
        throw ApiError(
            code = parsed?.error?.code?.wireValue ?: FALLBACK_ERROR_CODE,
            status = response.code,
            message = message
        )
    }

    private fun parseError(response: Response): ErrorBody? {
        val value = response.body?.string() ?: return null
        return try {
            ProtocolJson.decodeFromString(ErrorBody.serializer(), value)
        } catch (ignored: IllegalArgumentException) {
            null
        }
    }

    private fun responseBody(response: Response): ResponseBody = response.body ?: run {
        response.close()
        throw IOException(MISSING_RESPONSE_MESSAGE)
    }

    private suspend fun Call.await(): Response = suspendCancellableCoroutine { continuation ->
        continuation.invokeOnCancellation { cancel() }
        enqueue(
            object : Callback {
                override fun onFailure(call: Call, e: IOException) {
                    continuation.resumeWithException(e)
                }

                override fun onResponse(call: Call, response: Response) {
                    continuation.resume(response) { _, value, _ -> value.close() }
                }
            }
        )
    }

    companion object {
        private const val FALLBACK_ERROR_CODE = "http_error"
        private const val MISSING_RESPONSE_MESSAGE = "Response body is missing"
        private const val MALFORMED_RESPONSE_MESSAGE = "Response body is malformed"
    }
}
