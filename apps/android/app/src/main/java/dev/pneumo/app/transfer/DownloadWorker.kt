package dev.pneumo.app.transfer

import android.content.Context
import android.database.sqlite.SQLiteException
import androidx.work.CoroutineWorker
import androidx.work.ListenableWorker.Result
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import dev.pneumo.app.PneumoApp
import dev.pneumo.app.crypto.Base64Url
import dev.pneumo.app.crypto.FileCrypto
import dev.pneumo.app.net.ApiError
import dev.pneumo.app.protocol.DownloadTarget
import dev.pneumo.app.protocol.FilePayload
import dev.pneumo.app.protocol.GetFileResponse
import dev.pneumo.app.sync.DecryptedPush
import java.io.EOFException
import java.io.FilterInputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.security.GeneralSecurityException
import java.util.concurrent.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import okhttp3.ResponseBody

internal class DownloadSession(
    val deviceId: String,
    val loadPush: suspend (String) -> DecryptedPush?,
    val getFile: suspend (String) -> GetFileResponse,
    val download: suspend (DownloadTarget) -> ResponseBody,
    val finishSession: suspend (block: () -> Unit) -> Unit
)

internal class DownloadWorkerDependencies(
    val openSession: suspend () -> DownloadSession?,
    val destinations: DownloadDestinationFactory
) {
    companion object {
        fun create(context: Context): DownloadWorkerDependencies {
            val app = context.applicationContext as? PneumoApp
            return DownloadWorkerDependencies(
                openSession = {
                    app?.container?.openSession()?.let { session ->
                        DownloadSession(
                            deviceId = session.deviceId,
                            loadPush = session.pushes::get,
                            getFile = session.api::getFile,
                            download = session.api::downloadFrom,
                            finishSession = { block ->
                                session.cache.withPushes(session.generation) { block() }
                            }
                        )
                    }
                },
                destinations = AndroidDownloadDestinationFactory(context.applicationContext)
            )
        }
    }
}

private class DownloadSpec(
    val fileId: String,
    val ciphertextSize: Long,
    val plaintextSize: Long,
    val name: String,
    val mime: String,
    val encodedKey: String
)

class DownloadWorker internal constructor(
    appContext: Context,
    params: WorkerParameters,
    private val dependencies: DownloadWorkerDependencies
) : CoroutineWorker(appContext, params) {
    constructor(appContext: Context, params: WorkerParameters) :
        this(appContext, params, DownloadWorkerDependencies.create(appContext))

    private var activeDestination: DownloadDestination? = null
    private var completed = false

    override suspend fun doWork(): Result {
        val pushId = inputData.getString(INPUT_PUSH_ID)
        val initiatingDeviceId = inputData.getString(INPUT_SESSION_DEVICE_ID)
        return if (pushId == null) {
            Result.failure(failureData(DOWNLOAD_FAILED))
        } else if (initiatingDeviceId == null) {
            Result.failure(failureData(SESSION_CHANGED))
        } else {
            val notifications = DownloadNotifications(applicationContext, pushId)
            setForeground(notifications.foreground(null))
            runDownload(pushId, initiatingDeviceId, notifications)
        }
    }

    private suspend fun runDownload(
        pushId: String,
        initiatingDeviceId: String,
        notifications: DownloadNotifications
    ): Result {
        val session = openMatchingSession(initiatingDeviceId)
        return if (session == null) {
            Result.failure(failureData(SESSION_CHANGED))
        } else {
            val spec = loadSpec(session, pushId)
            if (spec == null) {
                Result.failure(failureData(DOWNLOAD_FAILED))
            } else {
                notifications.postDownloading(spec.name, null)
                executeTransfer(session, spec, notifications)
            }
        }
    }

    private suspend fun openMatchingSession(initiatingDeviceId: String): DownloadSession? {
        val session = try {
            dependencies.openSession()
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: IOException) {
            null
        } catch (_: GeneralSecurityException) {
            null
        } catch (_: IllegalArgumentException) {
            null
        } catch (_: IllegalStateException) {
            null
        }
        return session?.takeIf { it.deviceId == initiatingDeviceId }
    }

    private suspend fun loadSpec(session: DownloadSession, pushId: String): DownloadSpec? {
        val stored = try {
            session.loadPush(pushId)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: GeneralSecurityException) {
            null
        } catch (_: IllegalArgumentException) {
            null
        } catch (_: IllegalStateException) {
            null
        } catch (_: SQLiteException) {
            null
        }
        val payload = stored?.payload as? FilePayload
        val remoteFile = stored?.push?.file
        return if (payload == null || remoteFile == null) {
            null
        } else {
            DownloadSpec(
                fileId = remoteFile.id,
                ciphertextSize = remoteFile.size,
                plaintextSize = payload.file.size,
                name = payload.file.name,
                mime = payload.file.mime.ifBlank { DEFAULT_MIME },
                encodedKey = payload.file.key
            )
        }
    }

    private suspend fun executeTransfer(
        session: DownloadSession,
        spec: DownloadSpec,
        notifications: DownloadNotifications
    ): Result {
        activeDestination = null
        completed = false
        var fileKey: ByteArray? = null
        return try {
            val decodedKey = Base64Url.decode(spec.encodedKey)
            fileKey = decodedKey
            val target = performTransfer(session, spec, decodedKey, notifications)
            completed = true
            notifications.postComplete(spec.name, target.uri, spec.mime)
            Result.success(workDataOf(OUTPUT_URI to target.uri.toString()))
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (failure: ApiError) {
            classifyFailure(failure, notifications, spec.name)
        } catch (failure: EOFException) {
            classifyFailure(failure, notifications, spec.name)
        } catch (failure: IOException) {
            classifyFailure(failure, notifications, spec.name)
        } catch (failure: GeneralSecurityException) {
            classifyFailure(failure, notifications, spec.name)
        } catch (failure: IllegalArgumentException) {
            classifyFailure(failure, notifications, spec.name)
        } catch (failure: CorruptDownload) {
            classifyFailure(failure, notifications, spec.name)
        } catch (failure: TerminalDownload) {
            classifyFailure(failure, notifications, spec.name)
        } catch (failure: StorageFailure) {
            classifyFailure(failure, notifications, spec.name)
        } catch (failure: IllegalStateException) {
            classifyFailure(failure, notifications, spec.name)
        } finally {
            fileKey?.fill(0)
            if (!completed) deletePartial(activeDestination)
        }
    }

    private suspend fun performTransfer(
        session: DownloadSession,
        spec: DownloadSpec,
        fileKey: ByteArray,
        notifications: DownloadNotifications
    ): DownloadDestination {
        val expectedSize = expectedCiphertextSize(spec.plaintextSize)
        requireCiphertextSize(spec.ciphertextSize, expectedSize)
        val metadata = session.getFile(spec.fileId)
        session.download(metadata.download).use { response ->
            requireResponseSize(response.contentLength(), expectedSize)
            val target = createDestination(dependencies.destinations, spec)
            activeDestination = target
            decryptContent(response, target, spec, fileKey, notifications)
        }
        val target = checkNotNull(activeDestination)
        currentCoroutineContext().ensureActive()
        setProgress(workDataOf(PROGRESS to PROGRESS_MAX))
        currentCoroutineContext().ensureActive()
        session.finishSession { completeDestination(target) }
        return target
    }

    private suspend fun decryptContent(
        response: ResponseBody,
        target: DownloadDestination,
        spec: DownloadSpec,
        fileKey: ByteArray,
        notifications: DownloadNotifications
    ) = withContext(Dispatchers.IO) {
        val input = ProgressNetworkInputStream(
            response.byteStream(),
            spec.ciphertextSize,
            currentCoroutineContext()[Job]
        ) { progress ->
            setProgressAsync(workDataOf(PROGRESS to progress))
            setForegroundAsync(notifications.foreground(progress))
        }
        openDestination(target).use {
            FileCrypto.decrypt(input, it, fileKey, spec.fileId)
        }
    }

    private fun classifyFailure(failure: Exception, notifications: DownloadNotifications, name: String): Result =
        when (failure) {
            is ApiError -> if (failure.status == HTTP_RATE_LIMITED || failure.status >= HTTP_SERVER_ERROR) {
                Result.retry()
            } else {
                terminalFailure(notifications, name, DOWNLOAD_FAILED)
            }

            is EOFException -> terminalFailure(notifications, name, CORRUPTED_FILE)

            is IOException -> Result.retry()

            is GeneralSecurityException,
            is IllegalArgumentException,
            is CorruptDownload -> terminalFailure(notifications, name, CORRUPTED_FILE)

            is TerminalDownload -> terminalFailure(notifications, name, failure.safeMessage)

            is StorageFailure -> terminalFailure(notifications, name, DOWNLOAD_FAILED)

            is IllegalStateException -> terminalFailure(notifications, name, SESSION_CHANGED)

            else -> terminalFailure(notifications, name, DOWNLOAD_FAILED)
        }

    private fun terminalFailure(notifications: DownloadNotifications, name: String, message: String): Result {
        notifications.postFailed(name, message)
        return Result.failure(failureData(message))
    }

    companion object {
        internal const val INPUT_PUSH_ID = "push_id"
        internal const val INPUT_SESSION_DEVICE_ID = "session_device_id"
        internal const val OUTPUT_URI = "content_uri"
        internal const val OUTPUT_ERROR = "error"
        internal const val PROGRESS = "progress"
        internal const val CORRUPTED_FILE = "This file was corrupted or tampered with"
        internal const val DOWNLOAD_FAILED = "Download failed."
        internal const val SESSION_CHANGED = "This download belongs to a different session."
        private const val DEFAULT_MIME = "application/octet-stream"
        private const val PROGRESS_MAX = 100
        private const val HTTP_RATE_LIMITED = 429
        private const val HTTP_SERVER_ERROR = 500

        private fun failureData(message: String) = workDataOf(OUTPUT_ERROR to message)
    }
}

private fun expectedCiphertextSize(plaintextSize: Long): Long = try {
    FileCrypto.ciphertextSize(plaintextSize)
} catch (failure: ArithmeticException) {
    throw TerminalDownload(DownloadWorker.DOWNLOAD_FAILED, failure)
}

private fun requireCiphertextSize(actual: Long, expected: Long) {
    if (actual != expected) throw CorruptDownload()
}

private fun requireResponseSize(actual: Long, expected: Long) {
    if (actual >= 0L && actual != expected) throw CorruptDownload()
}

private fun createDestination(factory: DownloadDestinationFactory, spec: DownloadSpec): DownloadDestination =
    storageOperation {
        factory.create(spec.name, spec.mime)
    }

private fun openDestination(destination: DownloadDestination): OutputStream = storageOperation {
    StorageOutputStream(destination.openOutput())
}

private fun completeDestination(destination: DownloadDestination) {
    storageOperation { destination.complete() }
}

private inline fun <T> storageOperation(block: () -> T): T {
    val failure = try {
        return block()
    } catch (error: IOException) {
        error
    } catch (error: SecurityException) {
        error
    } catch (error: IllegalArgumentException) {
        error
    } catch (error: SQLiteException) {
        error
    } catch (error: IllegalStateException) {
        error
    }
    throw StorageFailure(failure)
}

private fun deletePartial(destination: DownloadDestination?) {
    try {
        destination?.delete()
    } catch (_: SecurityException) {
        // Preserve the original outcome if platform cleanup reports a second failure.
    } catch (_: IllegalArgumentException) {
        // Preserve the original outcome if platform cleanup reports a second failure.
    } catch (_: IllegalStateException) {
        // Preserve the original outcome if platform cleanup reports a second failure.
    } catch (_: SQLiteException) {
        // Preserve the original outcome if platform cleanup reports a second failure.
    }
}

private class ProgressNetworkInputStream(
    input: InputStream,
    private val expectedSize: Long,
    private val job: Job?,
    private val onProgress: (Int) -> Unit
) : FilterInputStream(input) {
    private var readBytes = 0L
    private var reportedProgress = -1

    override fun read(): Int = networkRead { super.read() }.also { value ->
        if (value >= 0) progressed(1)
    }

    override fun read(buffer: ByteArray, offset: Int, length: Int): Int =
        networkRead { super.read(buffer, offset, length) }.also { count ->
            if (count > 0) progressed(count)
        }

    private inline fun networkRead(read: () -> Int): Int {
        job?.ensureActive()
        return try {
            read()
        } catch (failure: IOException) {
            throw NetworkFailure(failure)
        }
    }

    private fun progressed(count: Int) {
        readBytes += count
        val progress = if (expectedSize == 0L) {
            PROGRESS_COMPLETE
        } else {
            ((readBytes.coerceAtMost(expectedSize) * PROGRESS_COMPLETE) / expectedSize).toInt()
        }
        if (progress != reportedProgress) {
            reportedProgress = progress
            onProgress(progress)
        }
    }

    private companion object {
        const val PROGRESS_COMPLETE = 100
    }
}

private class StorageOutputStream(private val output: OutputStream) : OutputStream() {
    override fun write(value: Int) = storageWrite { output.write(value) }

    override fun write(buffer: ByteArray, offset: Int, length: Int) =
        storageWrite { output.write(buffer, offset, length) }

    override fun flush() = storageWrite { output.flush() }

    override fun close() = storageWrite { output.close() }

    private inline fun storageWrite(write: () -> Unit) {
        try {
            write()
        } catch (failure: IOException) {
            throw StorageFailure(failure)
        }
    }
}

private class CorruptDownload : Exception()
private class TerminalDownload(val safeMessage: String, cause: Throwable) : Exception(cause)
private class NetworkFailure(cause: IOException) : IOException(cause)
private class StorageFailure(cause: Throwable) : Exception(cause)
