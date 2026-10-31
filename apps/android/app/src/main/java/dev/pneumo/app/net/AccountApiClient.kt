package dev.pneumo.app.net

import dev.pneumo.app.protocol.ClaimPairRequest
import dev.pneumo.app.protocol.ClaimPairResponse
import dev.pneumo.app.protocol.CreatePairResponse
import dev.pneumo.app.protocol.MeResponse
import okhttp3.RequestBody.Companion.toRequestBody

internal class AccountApiClient(private val context: ApiContext) : AccountApi {
    override suspend fun me(): MeResponse = context.executor.json(
        context.requests.authenticated(context.requests.apiUrl(ME_PATH)).get().build(),
        MeResponse.serializer(),
        HTTP_OK
    )

    override suspend fun createPair(): CreatePairResponse = context.executor.json(
        context.requests.authenticated(context.requests.apiUrl(PAIR_PATH))
            .post(EMPTY_REQUEST_BODY)
            .build(),
        CreatePairResponse.serializer(),
        HTTP_CREATED
    )

    override suspend fun claimPair(request: ClaimPairRequest): ClaimPairResponse = context.executor.json(
        context.requests.unauthenticated(context.requests.apiUrl(PAIR_CLAIM_PATH))
            .post(context.requests.jsonBody(ClaimPairRequest.serializer(), request))
            .build(),
        ClaimPairResponse.serializer(),
        HTTP_CREATED
    )

    companion object {
        private const val HTTP_OK = 200
        private const val HTTP_CREATED = 201
        private const val ME_PATH = "/api/me"
        private const val PAIR_PATH = "/api/pair"
        private const val PAIR_CLAIM_PATH = "/api/pair/claim"
        private val EMPTY_REQUEST_BODY = ByteArray(0).toRequestBody()
    }
}
