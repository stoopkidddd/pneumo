package dev.pneumo.app.net

import dev.pneumo.app.protocol.CreatePushRequest
import dev.pneumo.app.protocol.ListPushesQuery
import dev.pneumo.app.protocol.ListPushesResponse
import dev.pneumo.app.protocol.PushDTO

internal class PushApiClient(private val context: ApiContext) : PushApi {
    override suspend fun createPush(request: CreatePushRequest): PushDTO = context.executor.json(
        context.requests.authenticated(context.requests.apiUrl(PUSHES_PATH))
            .post(context.requests.jsonBody(CreatePushRequest.serializer(), request))
            .build(),
        PushDTO.serializer(),
        HTTP_CREATED,
        HTTP_OK
    )

    override suspend fun listPushes(before: String?, limit: Long): ListPushesResponse {
        val query = ListPushesQuery(before = before, limit = limit)
        val urlBuilder = context.requests.apiUrl(PUSHES_PATH).newBuilder()
        if (query.before != null) {
            urlBuilder.addQueryParameter(BEFORE_QUERY, query.before)
        }
        urlBuilder.addQueryParameter(LIMIT_QUERY, query.limit.toString())
        return context.executor.json(
            context.requests.authenticated(urlBuilder.build()).get().build(),
            ListPushesResponse.serializer(),
            HTTP_OK
        )
    }

    override suspend fun getPush(id: String): PushDTO = context.executor.json(
        context.requests.authenticated(context.requests.apiUrl(PUSHES_PATH, id)).get().build(),
        PushDTO.serializer(),
        HTTP_OK
    )

    override suspend fun deletePush(id: String) {
        context.executor.empty(
            context.requests.authenticated(context.requests.apiUrl(PUSHES_PATH, id)).delete().build(),
            HTTP_NO_CONTENT
        )
    }

    companion object {
        private const val HTTP_OK = 200
        private const val HTTP_CREATED = 201
        private const val HTTP_NO_CONTENT = 204
        private const val PUSHES_PATH = "/api/pushes"
        private const val BEFORE_QUERY = "before"
        private const val LIMIT_QUERY = "limit"
    }
}
