package dev.pneumo.app.net

import java.util.Base64
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Before

internal const val HTTP_OK = 200
internal const val HTTP_CREATED = 201
internal const val HTTP_NO_CONTENT = 204
internal const val HTTP_TEMPORARY_REDIRECT = 307
internal const val HTTP_UNAUTHORIZED = 401
internal const val HTTP_NOT_FOUND = 404
internal const val HTTP_INTERNAL_ERROR = 500
internal const val PROTOCOL_VERSION = 1L
internal const val PAGE_LIMIT = 25L
internal const val DEFAULT_PAGE_LIMIT = 50L
internal const val AUTHORIZATION = "Authorization"
internal const val TIMESTAMP = "2026-10-30T12:00:00.000Z"
internal const val DEVICE_ID = "018f0c6e-7a00-7000-8000-000000000001"
internal const val PUSH_ID = "018f0c6e-7a00-7000-8000-000000000002"
internal const val FILE_ID = "018f0c6e-7a00-7000-8000-000000000003"
internal const val MALFORMED_SENSITIVE_RESPONSE = "malformed-sensitive-response"
private const val CREDENTIAL_SIZE = 32
private const val PAIR_CODE_SIZE = 16
private const val NONCE_SIZE = 12
private const val PUBLIC_KEY_SIZE = 65
internal val FIXED_FAKE_BEARER = fixedBase64Url(CREDENTIAL_SIZE)
internal val CREDENTIAL = fixedBase64Url(CREDENTIAL_SIZE)
internal val PAIR_CODE = fixedBase64Url(PAIR_CODE_SIZE)
internal val NONCE = fixedBase64Url(NONCE_SIZE)
internal val CIPHERTEXT = fixedBase64Url(PAIR_CODE_SIZE)
internal val PUBLIC_KEY = fixedBase64Url(PUBLIC_KEY_SIZE)
internal val UPLOAD_BYTES = "fixed upload bytes".toByteArray()
internal const val DOWNLOAD_TEXT = "fixed download bytes"
internal val DOWNLOAD_BYTES = DOWNLOAD_TEXT.toByteArray()
internal val OCTET_STREAM = "application/octet-stream".toMediaType()
internal val DEVICE_RESPONSE =
    """{"name":"Fixed phone","platform":"android","id":"$DEVICE_ID",
        |"createdAt":"$TIMESTAMP","lastSeenAt":"$TIMESTAMP","online":true}
    """.trimMargin()
internal val ME_RESPONSE =
    """{"device":$DEVICE_RESPONSE,"keyCheck":"$CREDENTIAL",
        |"limits":{"maxFileBytes":524288000,"maxEnvelopeBytes":65536},
        |"vapidPublicKey":"$PUBLIC_KEY","uploadMode":"auto"}
    """.trimMargin()
internal val CLAIM_RESPONSE = """{"device":$DEVICE_RESPONSE,"token":"$CREDENTIAL"}"""
internal val PUSH_RESPONSE =
    """{"id":"$PUSH_ID","createdAt":"$TIMESTAMP","sourceDeviceId":"$DEVICE_ID","targetDeviceId":null,
        |"envelope":{"v":1,"n":"$NONCE","c":"$CIPHERTEXT"},"file":null}
    """.trimMargin()
internal const val EMPTY_PUSH_PAGE = """{"pushes":[],"nextBefore":null}"""

abstract class ApiClientTestSupport {
    protected lateinit var server: MockWebServer
    protected lateinit var client: ApiClient

    @Before
    fun setUpApiClient() {
        server = MockWebServer()
        server.start()
        client = ApiClient(server.url("/"), FIXED_FAKE_BEARER)
    }

    @After
    fun tearDownApiClient() {
        server.shutdown()
    }

    protected fun jsonResponse(body: String, status: Int = HTTP_OK): MockResponse = MockResponse()
        .setResponseCode(status)
        .setHeader("Content-Type", "application/json")
        .setBody(body)
}

private fun fixedBase64Url(size: Int): String = Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(size))
