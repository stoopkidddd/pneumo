package dev.pneumo.app.data

interface SessionLifecycle {
    fun paired()

    suspend fun cleared()
}
