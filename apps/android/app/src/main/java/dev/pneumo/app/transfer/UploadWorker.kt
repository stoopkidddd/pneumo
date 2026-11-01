package dev.pneumo.app.transfer

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.compose.ui.graphics.toArgb
import androidx.work.CoroutineWorker
import androidx.work.ForegroundInfo
import androidx.work.ListenableWorker.Result
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import dev.pneumo.app.PneumoApp
import dev.pneumo.app.R
import dev.pneumo.app.crypto.Base64Url
import dev.pneumo.app.crypto.FileCrypto
import dev.pneumo.app.crypto.PushCrypto
import dev.pneumo.app.data.AppSession
import dev.pneumo.app.data.db.toEntity
import dev.pneumo.app.net.ApiError
import dev.pneumo.app.protocol.CreateFileRequest
import dev.pneumo.app.protocol.CreatePushFile
import dev.pneumo.app.protocol.Envelope
import dev.pneumo.app.protocol.FilePayload
import dev.pneumo.app.protocol.PayloadFile
import dev.pneumo.app.protocol.ProtocolJson
import dev.pneumo.app.protocol.PushDTO
import dev.pneumo.app.ui.theme.BrandColors
import java.io.IOException
import java.security.GeneralSecurityException
import java.util.concurrent.CancellationException

internal class UploadWorkerDependencies(
    val store: UploadWorkStore,
    val openSession: suspend () -> AppSession?,
    val storePush: suspend (PushDTO) -> Unit
)

class UploadWorker(appContext: Context, params: WorkerParameters) : CoroutineWorker(appContext, params) {
    private var injectedDependencies: UploadWorkerDependencies? = null

    internal constructor(
        appContext: Context,
        params: WorkerParameters,
        dependencies: UploadWorkerDependencies
    ) : this(appContext, params) {
        injectedDependencies = dependencies
    }

    override suspend fun getForegroundInfo(): ForegroundInfo =
        UploadForeground(applicationContext, id.hashCode()).info(0)

    override suspend fun doWork(): Result {
        val key = inputData.getString(INPUT_SPOOL_KEY)
        val result = if (key == null) {
            failure("Could not read the upload.")
        } else {
            val foreground = UploadForeground(applicationContext, id.hashCode())
            setForeground(foreground.info(0))
            setProgress(workDataOf(UploadScheduler.PROGRESS_PERCENT to 0))
            val dependencies = injectedDependencies ?: productionDependencies()
            if (dependencies == null) {
                UploadWorkStore.create(applicationContext).delete(key)
                failure("Your paired session changed. Try again.")
            } else {
                runStoredUploadWork(applicationContext, key, dependencies) { percent ->
                    setProgressAsync(workDataOf(UploadScheduler.PROGRESS_PERCENT to percent))
                    foreground.update(percent)
                }
            }
        }
        return result
    }

    private fun productionDependencies(): UploadWorkerDependencies? {
        val app = applicationContext as? PneumoApp ?: return null
        return UploadWorkerDependencies(
            store = UploadWorkStore.create(applicationContext),
            openSession = app.container::openSession,
            storePush = { created -> app.container.database.pushes().insert(created.toEntity()) }
        )
    }

    private fun failure(message: String): Result = Result.failure(
        workDataOf(UploadScheduler.ERROR_MESSAGE to message)
    )

    companion object {
        internal const val INPUT_SPOOL_KEY = "spool_key"
    }
}

private class UploadRunContext(
    val context: Context,
    val key: String,
    val dependencies: UploadWorkerDependencies,
    val session: AppSession,
    val onProgress: (Int) -> Unit
)

internal suspend fun runStoredUploadWork(
    context: Context,
    key: String,
    dependencies: UploadWorkerDependencies,
    onProgress: (Int) -> Unit = {}
): Result {
    var terminal = true
    return try {
        val work = runCatching { dependencies.store.read(key) }
            .getOrElse { failure -> throw UploadSpoolException(failure) }
        val session = dependencies.openSession()
        if (session == null || session.deviceId != work.sessionDeviceId) {
            Result.failure(failureData("Your paired session changed. Try again."))
        } else {
            processUploadWork(UploadRunContext(context, key, dependencies, session, onProgress), work)
        }
    } catch (cancelled: CancellationException) {
        terminal = false
        throw cancelled
    } catch (failure: ApiError) {
        terminal = !failure.isRetryableUploadFailure()
        failure.toWorkerResult()
    } catch (failure: IOException) {
        terminal = !failure.isRetryableUploadFailure()
        failure.toWorkerResult()
    } catch (failure: UploadSpoolException) {
        Result.failure(failureData(failure.publicUploadMessage()))
    } catch (failure: UploadLimitException) {
        Result.failure(failureData(failure.publicUploadMessage()))
    } catch (failure: IllegalArgumentException) {
        Result.failure(failureData(failure.publicUploadMessage()))
    } catch (failure: IllegalStateException) {
        Result.failure(failureData(failure.publicUploadMessage()))
    } catch (failure: SecurityException) {
        Result.failure(failureData(failure.publicUploadMessage()))
    } catch (failure: GeneralSecurityException) {
        Result.failure(failureData(failure.publicUploadMessage()))
    } finally {
        if (terminal) dependencies.store.delete(key)
    }
}

private suspend fun processUploadWork(run: UploadRunContext, initialWork: StoredUploadWork): Result {
    validateCurrentLimits(run.session, initialWork)
    val total = initialWork.items.size
    var completed = 0
    var work = initialWork
    while (work.items.isNotEmpty()) {
        work = ensureFirstItemUploaded(
            run = run,
            work = work,
            progress = { itemPercent ->
                val overall = ((completed * PERCENT_MAX) + itemPercent) / total
                run.onProgress(overall.coerceIn(0, PERCENT_MAX))
            }
        )
        val completedItem = work.items.first()
        sendUploadedItem(run.session, completedItem, run.dependencies.storePush)
        completed += 1
        work = work.copy(items = work.items.drop(1))
        if (work.items.isNotEmpty()) {
            writeStoredWork(run.dependencies.store, run.key, work)
            run.dependencies.store.sources.deleteSource(run.key, completedItem.sourceUri)
        }
        run.onProgress((completed * PERCENT_MAX) / total)
    }
    return Result.success(workDataOf(UploadScheduler.PROGRESS_PERCENT to PERCENT_MAX))
}

private suspend fun validateCurrentLimits(session: AppSession, work: StoredUploadWork) {
    if (work.items.isEmpty()) throw UploadSpoolException()
    if (work.items.none { it.request.file == null }) return
    val limits = session.api.me().limits
    work.items.forEach { item ->
        validatePendingItem(item, limits.maxFileBytes, limits.maxEnvelopeBytes)
    }
}

private fun validatePendingItem(item: StoredUploadItem, maxFileBytes: Long, maxEnvelopeBytes: Long) {
    if (item.request.file != null) return
    if (item.ciphertextSize > maxFileBytes) {
        throw UploadLimitException("This file is too large to send.")
    }
    val envelopeBytes = ProtocolJson.encodeToString(Envelope.serializer(), item.request.envelope).length.toLong()
    if (envelopeBytes > maxEnvelopeBytes) {
        throw UploadLimitException("This file's message is too large. Shorten it and try again.")
    }
}

private suspend fun ensureFirstItemUploaded(
    run: UploadRunContext,
    work: StoredUploadWork,
    progress: (Int) -> Unit
): StoredUploadWork {
    val item = work.items.first()
    if (item.request.file != null) {
        progress(PERCENT_MAX)
        return work
    }
    checkedStoredCiphertextSize(item)
    check(run.session.cache.generation() == run.session.generation) { "The paired session has changed." }
    val reservation = run.session.api.createFile(CreateFileRequest(item.ciphertextSize))
    val fileKey = FileCrypto.generateFileKey()
    try {
        val payload = PushCrypto.decrypt(
            run.session.contentKey,
            item.request.id,
            item.request.envelope
        ) as? FilePayload ?: throw UploadSpoolException()
        val encodedFileKey = Base64Url.encode(fileKey)
        val rotatedPayload = FilePayload(
            title = payload.title,
            body = payload.body,
            file = PayloadFile(
                name = payload.file.name,
                mime = payload.file.mime,
                size = payload.file.size,
                key = encodedFileKey
            )
        )
        val reservedItem = item.copy(
            fileKey = encodedFileKey,
            request = item.request.copy(
                envelope = PushCrypto.encrypt(run.session.contentKey, item.request.id, rotatedPayload)
            )
        )
        val reservedWork = work.replaceFirst(reservedItem)
        writeStoredWork(run.dependencies.store, run.key, reservedWork)
        val body = EncryptedFileRequestBody(
            EncryptedUploadSource(
                context = run.context,
                item = reservedItem,
                fileKey = fileKey,
                fileId = reservation.fileId
            ),
            progress
        )
        run.session.api.uploadTo(reservation.upload, body)
        val uploadedWork = reservedWork.replaceFirst(
            reservedItem.copy(request = reservedItem.request.copy(file = CreatePushFile(reservation.fileId)))
        )
        writeStoredWork(run.dependencies.store, run.key, uploadedWork)
        return uploadedWork
    } finally {
        fileKey.fill(0)
    }
}

private fun StoredUploadWork.replaceFirst(item: StoredUploadItem): StoredUploadWork {
    val updatedItems = items.toMutableList()
    updatedItems[0] = item
    return copy(items = updatedItems)
}

private suspend fun sendUploadedItem(
    session: AppSession,
    item: StoredUploadItem,
    storePush: suspend (PushDTO) -> Unit
) {
    if (item.request.file == null) throw UploadSpoolException()
    val created = session.api.createPush(item.request)
    session.cache.withPushes(session.generation) {
        storePush(created)
    }
}

private fun writeStoredWork(store: UploadWorkStore, key: String, work: StoredUploadWork) {
    runCatching { store.write(key, work) }
        .getOrElse { failure -> throw UploadSpoolException(failure) }
}

private fun checkedStoredCiphertextSize(item: StoredUploadItem) {
    val expectedSize = runCatching { FileCrypto.ciphertextSize(item.plaintextSize) }
        .getOrElse { failure -> throw UploadSpoolException(failure) }
    if (expectedSize != item.ciphertextSize) throw UploadSpoolException()
}

internal class UploadForeground(
    private val context: Context,
    workerHash: Int,
    private val notificationProgress: TransferProgressThrottle = TransferProgressThrottle()
) {
    private val manager = context.getSystemService(NotificationManager::class.java)
    private val notificationId = (workerHash and NOTIFICATION_ID_MASK) + NOTIFICATION_ID_OFFSET

    init {
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Transfers", NotificationManager.IMPORTANCE_LOW)
        )
    }

    fun info(percent: Int): ForegroundInfo {
        val notification = notification(percent)
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ForegroundInfo(notificationId, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            ForegroundInfo(notificationId, notification)
        }
    }

    fun update(percent: Int) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            return
        }
        if (!notificationProgress.shouldNotify(percent)) return
        try {
            manager.notify(notificationId, notification(percent))
        } catch (_: SecurityException) {
            // WorkManager retains the foreground notification when notification permission is denied.
        }
    }

    private fun notification(percent: Int): Notification = Notification.Builder(context, CHANNEL_ID)
        .setSmallIcon(R.drawable.ic_notification)
        .setColor(BrandColors.Light.Accent.toArgb())
        .setContentTitle("Uploading file")
        .setContentText("$percent%")
        .setProgress(PERCENT_MAX, percent.coerceIn(0, PERCENT_MAX), false)
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .setCategory(Notification.CATEGORY_PROGRESS)
        .setVisibility(Notification.VISIBILITY_PRIVATE)
        .build()

    private companion object {
        const val CHANNEL_ID = "transfers"
        const val NOTIFICATION_ID_MASK = 0x3fffffff
        const val NOTIFICATION_ID_OFFSET = 1_000
    }
}

private const val PERCENT_MAX = 100
