package dev.pneumo.app.data

import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** Serializes each HTTP cache operation with matching live frames and session teardown. */
class SessionCache {
    private val epoch = AtomicLong()
    private val pushMutex = Mutex()
    private val deviceMutex = Mutex()

    fun generation(): Long = epoch.get()

    suspend fun <T> withPushes(generation: Long, block: suspend () -> T): T = pushMutex.withLock {
        check(epoch.get() == generation) { "The paired session has changed." }
        block()
    }

    suspend fun <T> withDevices(generation: Long, block: suspend () -> T): T = deviceMutex.withLock {
        check(epoch.get() == generation) { "The paired session has changed." }
        block()
    }

    suspend fun clear(block: suspend () -> Unit) {
        pushMutex.withLock {
            deviceMutex.withLock {
                epoch.incrementAndGet()
                block()
            }
        }
    }
}
