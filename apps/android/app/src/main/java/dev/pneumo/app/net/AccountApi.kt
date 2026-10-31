package dev.pneumo.app.net

import dev.pneumo.app.protocol.ClaimPairRequest
import dev.pneumo.app.protocol.ClaimPairResponse
import dev.pneumo.app.protocol.CreatePairResponse
import dev.pneumo.app.protocol.MeResponse

interface AccountApi {
    suspend fun me(): MeResponse

    suspend fun createPair(): CreatePairResponse

    suspend fun claimPair(request: ClaimPairRequest): ClaimPairResponse
}
