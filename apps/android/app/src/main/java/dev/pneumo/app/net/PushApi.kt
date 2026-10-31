package dev.pneumo.app.net

import dev.pneumo.app.protocol.CreatePushRequest
import dev.pneumo.app.protocol.ListPushesResponse
import dev.pneumo.app.protocol.PushDTO

interface PushApi {
    suspend fun createPush(request: CreatePushRequest): PushDTO

    suspend fun listPushes(before: String? = null, limit: Long = DEFAULT_LIMIT): ListPushesResponse

    suspend fun getPush(id: String): PushDTO

    suspend fun deletePush(id: String)

    companion object {
        const val DEFAULT_LIMIT = 50L
    }
}
