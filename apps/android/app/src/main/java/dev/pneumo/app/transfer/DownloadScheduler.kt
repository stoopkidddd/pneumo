package dev.pneumo.app.transfer

import android.content.Context
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.workDataOf
import dev.pneumo.app.PneumoApp
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

object DownloadScheduler {
    suspend fun enqueue(context: Context, pushId: String) {
        require(pushId.isNotBlank()) { "pushId must not be blank" }
        val application = context.applicationContext
        val app = checkNotNull(application as? PneumoApp) { "Download is unavailable" }
        val session = checkNotNull(app.container.openSession()) { "Download is unavailable" }
        val request = OneTimeWorkRequestBuilder<DownloadWorker>()
            .setConstraints(
                Constraints.Builder()
                    .setRequiredNetworkType(NetworkType.CONNECTED)
                    .build()
            )
            .setInputData(
                workDataOf(
                    DownloadWorker.INPUT_PUSH_ID to pushId,
                    DownloadWorker.INPUT_SESSION_DEVICE_ID to session.deviceId
                )
            )
            .addTag(DownloadTransfers.WORK_TAG)
            .addTag(DownloadTransfers.pushTag(pushId))
            .build()
        val workManager = WorkManager.getInstance(application)
        val operation = workManager.enqueueUniqueWork(
            uniqueName(pushId),
            ExistingWorkPolicy.KEEP,
            request
        )
        withContext(Dispatchers.IO) {
            val failure = try {
                operation.result.get(ENQUEUE_WAIT_MILLIS, TimeUnit.MILLISECONDS)
                null
            } catch (error: ExecutionException) {
                IllegalStateException("Could not enqueue download", error.cause ?: error)
            } catch (error: TimeoutException) {
                workManager.cancelWorkById(request.id)
                IllegalStateException("Download enqueue timed out", error)
            } catch (error: InterruptedException) {
                try {
                    workManager.cancelWorkById(request.id)
                } finally {
                    Thread.currentThread().interrupt()
                }
                IllegalStateException("Download enqueue was interrupted", error)
            }
            failure?.let { throw it }
        }
    }

    internal fun uniqueName(pushId: String): String = "download:$pushId"

    private const val ENQUEUE_WAIT_MILLIS = 750L
}
