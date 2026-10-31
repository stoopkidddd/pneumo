package dev.pneumo.app.transfer

import android.content.Context
import androidx.work.Constraints
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequest
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import androidx.work.workDataOf
import dev.pneumo.app.crypto.Base64Url
import dev.pneumo.app.crypto.FileCrypto
import dev.pneumo.app.crypto.PushCrypto
import dev.pneumo.app.crypto.Uuidv7
import dev.pneumo.app.data.AppSession
import dev.pneumo.app.protocol.CreatePushRequest
import dev.pneumo.app.protocol.Envelope
import dev.pneumo.app.protocol.FilePayload
import dev.pneumo.app.protocol.PayloadFile
import dev.pneumo.app.protocol.ProtocolJson
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

data class UploadOptions(
    val targetDeviceId: String?,
    val title: String? = null,
    val body: String? = null,
    val maxFileBytes: Long,
    val maxEnvelopeBytes: Long
)

object UploadScheduler {
    const val WORK_TAG = "file_upload"
    const val PROGRESS_PERCENT = "progress_percent"
    const val ERROR_MESSAGE = "error_message"

    suspend fun enqueue(
        context: Context,
        session: AppSession,
        attachments: List<UploadAttachment>,
        options: UploadOptions
    ): Unit = withContext(Dispatchers.IO) {
        val applicationContext = context.applicationContext
        validatePreparedAttachments(applicationContext, attachments, options)
        val items = attachments.mapIndexed { index, attachment ->
            createItem(
                attachment = attachment,
                ciphertextSize = checkedCiphertextSize(attachment.size, options.maxFileBytes),
                session = session,
                options = options,
                index = index
            )
        }
        persistAndEnqueue(applicationContext, session.deviceId, attachments, items)
    }

    private fun validatePreparedAttachments(
        context: Context,
        attachments: List<UploadAttachment>,
        options: UploadOptions
    ) {
        require(attachments.isNotEmpty()) { "Select at least one file." }
        require(options.maxFileBytes >= 0L && options.maxEnvelopeBytes >= 0L) {
            "Invalid server upload limits."
        }
        attachments.forEach { attachment ->
            require(attachment.size >= 0L) { "The selected file cannot be read." }
            requireNotNull(UploadAttachments.ownedPreparedFile(context, attachment.uri)) {
                "The selected file must be prepared before it is queued."
            }
        }
    }

    private fun checkedCiphertextSize(plaintextSize: Long, maxFileBytes: Long): Long {
        val ciphertextSize = try {
            FileCrypto.ciphertextSize(plaintextSize)
        } catch (_: ArithmeticException) {
            throw IllegalArgumentException(FILE_TOO_LARGE_MESSAGE)
        }
        require(ciphertextSize <= maxFileBytes) { FILE_TOO_LARGE_MESSAGE }
        return ciphertextSize
    }

    private fun createItem(
        attachment: UploadAttachment,
        ciphertextSize: Long,
        session: AppSession,
        options: UploadOptions,
        index: Int
    ): StoredUploadItem {
        val fileKey = FileCrypto.generateFileKey()
        return try {
            val pushId = Uuidv7.generate()
            val encodedFileKey = Base64Url.encode(fileKey)
            val payload = FilePayload(
                title = options.title.takeIf { index == 0 }?.takeIf(String::isNotBlank),
                body = options.body.takeIf { index == 0 }?.takeIf(String::isNotBlank),
                file = PayloadFile(
                    name = attachment.name,
                    mime = attachment.mime,
                    size = attachment.size,
                    key = encodedFileKey
                )
            )
            val envelope = PushCrypto.encrypt(session.contentKey, pushId, payload)
            val envelopeBytes = ProtocolJson.encodeToString(Envelope.serializer(), envelope).length.toLong()
            require(envelopeBytes <= options.maxEnvelopeBytes) {
                "This file's message is too large. Shorten it and try again."
            }
            StoredUploadItem(
                sourceUri = attachment.uri.toString(),
                plaintextSize = attachment.size,
                ciphertextSize = ciphertextSize,
                fileKey = encodedFileKey,
                request = CreatePushRequest(
                    id = pushId,
                    targetDeviceId = options.targetDeviceId,
                    envelope = envelope,
                    file = null
                )
            )
        } finally {
            fileKey.fill(0)
        }
    }

    private fun persistAndEnqueue(
        context: Context,
        sessionDeviceId: String,
        attachments: List<UploadAttachment>,
        initialItems: List<StoredUploadItem>
    ) {
        val store = UploadWorkStore.create(context)
        val key = store.newKey()
        var enqueued = false
        try {
            val items = initialItems.mapIndexed { index, item ->
                item.copy(
                    sourceUri = store.sources.adopt(
                        context = context,
                        key = key,
                        index = index,
                        uri = attachments[index].uri
                    )
                )
            }
            store.write(key, StoredUploadWork(sessionDeviceId, items))
            awaitEnqueue(WorkManager.getInstance(context), workRequest(key))
            enqueued = true
        } finally {
            if (!enqueued) {
                store.sources.restore(context, key, attachments)
                store.delete(key)
            }
        }
    }

    private fun workRequest(key: String): OneTimeWorkRequest = OneTimeWorkRequestBuilder<UploadWorker>()
        .setConstraints(
            Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build()
        )
        .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
        .setInputData(workDataOf(UploadWorker.INPUT_SPOOL_KEY to key))
        .addTag(WORK_TAG)
        .build()

    private fun awaitEnqueue(workManager: WorkManager, work: OneTimeWorkRequest) {
        val failure = try {
            workManager.enqueue(work).result.get(ENQUEUE_WAIT_MILLIS, TimeUnit.MILLISECONDS)
            null
        } catch (error: ExecutionException) {
            IllegalStateException("Could not enqueue the upload.", error.cause ?: error)
        } catch (error: TimeoutException) {
            workManager.cancelWorkById(work.id)
            IllegalStateException("The upload enqueue timed out.", error)
        } catch (error: InterruptedException) {
            try {
                workManager.cancelWorkById(work.id)
            } finally {
                Thread.currentThread().interrupt()
            }
            IllegalStateException("The upload enqueue was interrupted.", error)
        }
        failure?.let { throw it }
    }

    private const val FILE_TOO_LARGE_MESSAGE = "This file is too large to send."
    private const val ENQUEUE_WAIT_MILLIS = 750L
}
