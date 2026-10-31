package dev.pneumo.app.transfer

import android.content.ContentResolver
import android.content.Context
import android.database.sqlite.SQLiteException
import android.net.Uri
import androidx.work.WorkInfo
import androidx.work.WorkManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.map

sealed interface DownloadState {
    data class Downloading(val progress: Int?) : DownloadState
    data class Done(val uri: Uri, val mime: String) : DownloadState
    data class Failed(val message: String) : DownloadState
}

object DownloadTransfers {
    fun observe(context: Context): Flow<Map<String, DownloadState>> {
        val application = context.applicationContext
        val resolver = application.contentResolver
        return WorkManager.getInstance(application)
            .getWorkInfosByTagFlow(WORK_TAG)
            .map { states(resolver, it) }
            .flowOn(Dispatchers.IO)
    }

    internal const val WORK_TAG = "download_transfer"

    internal fun pushTag(pushId: String): String = "$PUSH_TAG_PREFIX$pushId"

    private fun states(resolver: ContentResolver, infos: List<WorkInfo>): Map<String, DownloadState> {
        val selected = HashMap<String, WorkInfo>()
        for (info in infos) {
            val pushId = info.tags.firstOrNull { it.startsWith(PUSH_TAG_PREFIX) }
                ?.removePrefix(PUSH_TAG_PREFIX)
                ?: continue
            val current = selected[pushId]
            if (current == null || preferredOver(info, current)) selected[pushId] = info
        }
        val result = HashMap<String, DownloadState>(selected.size)
        for ((pushId, info) in selected) result[pushId] = state(resolver, info)
        return result
    }

    private fun preferredOver(candidate: WorkInfo, current: WorkInfo): Boolean = priority(candidate) > priority(current)

    private fun priority(info: WorkInfo): Int = when {
        !info.state.isFinished -> ACTIVE_PRIORITY
        info.state == WorkInfo.State.SUCCEEDED -> SUCCESS_PRIORITY
        else -> TERMINAL_PRIORITY
    }

    private fun state(resolver: ContentResolver, info: WorkInfo): DownloadState = when (info.state) {
        WorkInfo.State.SUCCEEDED -> {
            val uri = info.outputData.getString(DownloadWorker.OUTPUT_URI)
                ?.let(Uri::parse)
                ?.takeIf { it.scheme == ContentResolver.SCHEME_CONTENT }
            if (uri != null) {
                val mime = mimeType(resolver, uri) ?: DEFAULT_MIME
                DownloadState.Done(uri, mime)
            } else {
                DownloadState.Failed(DownloadWorker.DOWNLOAD_FAILED)
            }
        }

        WorkInfo.State.FAILED -> DownloadState.Failed(
            info.outputData.getString(DownloadWorker.OUTPUT_ERROR) ?: DownloadWorker.DOWNLOAD_FAILED
        )

        WorkInfo.State.CANCELLED -> DownloadState.Failed(DownloadWorker.DOWNLOAD_FAILED)

        WorkInfo.State.RUNNING -> DownloadState.Downloading(
            info.progress.getInt(DownloadWorker.PROGRESS, MISSING_PROGRESS)
                .takeUnless { it == MISSING_PROGRESS }
        )

        WorkInfo.State.ENQUEUED,
        WorkInfo.State.BLOCKED -> DownloadState.Downloading(null)
    }

    private fun mimeType(resolver: ContentResolver, uri: Uri): String? = try {
        resolver.getType(uri)
    } catch (_: SecurityException) {
        null
    } catch (_: IllegalArgumentException) {
        null
    } catch (_: IllegalStateException) {
        null
    } catch (_: SQLiteException) {
        null
    }

    private const val ACTIVE_PRIORITY = 2
    private const val SUCCESS_PRIORITY = 1
    private const val TERMINAL_PRIORITY = 0
    private const val PUSH_TAG_PREFIX = "download_push:"
    private const val MISSING_PROGRESS = -1
    private const val DEFAULT_MIME = "application/octet-stream"
}
