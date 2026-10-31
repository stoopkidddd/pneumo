package dev.pneumo.app.ui.share

import android.content.Context
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ListenableWorker.Result
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequest
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import dev.pneumo.app.PneumoApp
import dev.pneumo.app.data.SessionCache
import dev.pneumo.app.data.db.toEntity
import dev.pneumo.app.net.ApiError
import dev.pneumo.app.protocol.CreatePushRequest
import dev.pneumo.app.protocol.PushDTO
import java.io.IOException
import java.util.concurrent.CancellationException
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

internal class ShareSendSession(
    val deviceId: String,
    val generation: Long,
    val cache: SessionCache,
    val create: suspend (CreatePushRequest) -> PushDTO,
    val store: suspend (PushDTO) -> Unit
)

internal suspend fun runStoredShareWork(
    key: String,
    store: ShareWorkStore,
    openSession: suspend () -> ShareSendSession?
): Result {
    var terminal = true
    return try {
        val work = store.read(key)
        val session = openSession()
        if (session != null && session.deviceId == work.sessionDeviceId) {
            if (sendStoredShare(session, work.request)) {
                Result.success()
            } else {
                terminal = false
                Result.retry()
            }
        } else {
            Result.failure()
        }
    } catch (cancelled: CancellationException) {
        terminal = false
        throw cancelled
    } catch (_: Exception) {
        Result.failure()
    } finally {
        if (terminal) store.delete(key)
    }
}

private suspend fun sendStoredShare(session: ShareSendSession, request: CreatePushRequest): Boolean = try {
    val created = session.create(request)
    session.cache.withPushes(session.generation) {
        session.store(created)
    }
    true
} catch (failure: ApiError) {
    if (failure.status >= HTTP_SERVER_ERROR || failure.status == HTTP_RATE_LIMITED) {
        false
    } else {
        throw failure
    }
} catch (_: IOException) {
    false
}

class SharePushWorker(appContext: Context, params: WorkerParameters) : CoroutineWorker(appContext, params) {
    override suspend fun doWork(): Result {
        val key = inputData.getString(INPUT_SPOOL_KEY)
        val result = if (key == null) {
            Result.failure()
        } else {
            val store = ShareWorkStore.create(applicationContext)
            val app = applicationContext as? PneumoApp
            if (app == null) {
                store.delete(key)
                Result.failure()
            } else {
                runStoredShareWork(key, store) {
                    app.container.openSession()?.let { session ->
                        ShareSendSession(
                            deviceId = session.deviceId,
                            generation = session.generation,
                            cache = session.cache,
                            create = session.api::createPush,
                            store = { created ->
                                app.container.database.pushes().insert(created.toEntity())
                            }
                        )
                    }
                }
            }
        }
        return result
    }

    companion object {
        internal const val INPUT_SPOOL_KEY = "spool_key"
    }
}

private const val HTTP_RATE_LIMITED = 429
private const val HTTP_SERVER_ERROR = 500

internal object ShareWorkScheduler {
    fun enqueue(context: Context, sessionDeviceId: String, request: CreatePushRequest) {
        val store = ShareWorkStore.create(context)
        val key = store.write(StoredShareWork(sessionDeviceId, request))
        deleteStoredWorkOnFailure(store, key) {
            val work = OneTimeWorkRequestBuilder<SharePushWorker>()
                .setConstraints(
                    Constraints.Builder()
                        .setRequiredNetworkType(NetworkType.CONNECTED)
                        .build()
                )
                .setInputData(workDataOf(SharePushWorker.INPUT_SPOOL_KEY to key))
                .addTag(WORK_TAG)
                .build()
            val workManager = WorkManager.getInstance(context.applicationContext)
            awaitEnqueue(workManager, work)
        }
    }

    private inline fun deleteStoredWorkOnFailure(store: ShareWorkStore, key: String, enqueue: () -> Unit) {
        var successful = false
        try {
            enqueue()
            successful = true
        } finally {
            if (!successful) store.delete(key)
        }
    }

    private fun awaitEnqueue(workManager: WorkManager, work: OneTimeWorkRequest) {
        val failure = try {
            workManager.enqueue(work)
                .result
                .get(ENQUEUE_WAIT_MILLIS, TimeUnit.MILLISECONDS)
            null
        } catch (error: ExecutionException) {
            IllegalStateException("Could not enqueue share work", error.cause ?: error)
        } catch (error: TimeoutException) {
            workManager.cancelWorkById(work.id)
            IllegalStateException("Share work enqueue timed out", error)
        } catch (error: InterruptedException) {
            try {
                workManager.cancelWorkById(work.id)
            } finally {
                Thread.currentThread().interrupt()
            }
            IllegalStateException("Share work enqueue was interrupted", error)
        }
        failure?.let { throw it }
    }

    private const val WORK_TAG = "share_push"
    private const val ENQUEUE_WAIT_MILLIS = 750L
}
