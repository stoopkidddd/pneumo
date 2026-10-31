package dev.pneumo.app.data

interface SessionLifecycle {
    suspend fun claimed(createdAt: String)

    fun paired()

    suspend fun cleared()
}
