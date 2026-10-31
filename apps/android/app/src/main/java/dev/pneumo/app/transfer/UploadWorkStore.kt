package dev.pneumo.app.transfer

import android.content.ContentResolver
import android.content.Context
import android.net.Uri
import androidx.core.net.toUri
import dev.pneumo.app.data.KeyWrapper
import dev.pneumo.app.data.KeystoreKeyWrapper
import dev.pneumo.app.protocol.CreatePushRequest
import dev.pneumo.app.protocol.ProtocolJson
import java.io.File
import java.io.FileOutputStream
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.util.UUID
import kotlinx.serialization.Serializable

@Serializable
internal data class StoredUploadItem(
    val sourceUri: String,
    val plaintextSize: Long,
    val ciphertextSize: Long,
    val fileKey: String,
    val request: CreatePushRequest
)

@Serializable
internal data class StoredUploadWork(val sessionDeviceId: String, val items: List<StoredUploadItem>)

/** Stores upload metadata as authenticated ciphertext; WorkManager receives only the random key. */
internal class UploadWorkStore(private val directory: File, sourceDirectory: File, private val keyWrapper: KeyWrapper) {
    val sources = UploadSourceStore(sourceDirectory)
    fun newKey(): String = UUID.randomUUID().toString()

    fun write(key: String, work: StoredUploadWork) {
        require(work.items.isNotEmpty()) { "Upload work must contain at least one file." }
        check(directory.exists() || directory.mkdirs()) { "Could not create the upload work directory." }
        val destination = file(key)
        val temporary = File(directory, "$key.tmp")
        val plaintext = ProtocolJson.encodeToString(StoredUploadWork.serializer(), work).toByteArray(Charsets.UTF_8)
        try {
            val ciphertext = keyWrapper.wrap(plaintext)
            try {
                FileOutputStream(temporary).use { output ->
                    output.write(ciphertext)
                    output.fd.sync()
                }
                moveReplacing(temporary, destination)
            } finally {
                ciphertext.fill(0)
            }
        } finally {
            plaintext.fill(0)
            temporary.delete()
        }
    }

    fun read(key: String): StoredUploadWork {
        val ciphertext = file(key).readBytes()
        return try {
            val plaintext = keyWrapper.unwrap(ciphertext)
            try {
                ProtocolJson.decodeFromString(StoredUploadWork.serializer(), plaintext.toString(Charsets.UTF_8))
            } finally {
                plaintext.fill(0)
            }
        } finally {
            ciphertext.fill(0)
        }
    }

    fun delete(key: String) {
        try {
            file(key).delete()
            sources.deleteAll(key)
        } catch (_: IllegalArgumentException) {
            // Invalid WorkManager input has no corresponding spool or source directory.
        }
    }

    fun exists(key: String): Boolean = file(key).exists()

    private fun file(key: String): File {
        validateUploadKey(key)
        return File(directory, "$key.work")
    }

    companion object {
        fun create(context: Context): UploadWorkStore {
            val applicationContext = context.applicationContext
            return UploadWorkStore(
                directory = File(applicationContext.noBackupFilesDir, WORK_DIRECTORY),
                sourceDirectory = File(applicationContext.cacheDir, JOB_SOURCE_DIRECTORY),
                keyWrapper = KeystoreKeyWrapper()
            )
        }

        private const val WORK_DIRECTORY = "upload_work"
        private const val JOB_SOURCE_DIRECTORY = "upload_jobs"
    }
}
internal class UploadSourceStore(private val directory: File) {
    fun adopt(context: Context, key: String, index: Int, uri: Uri): String {
        val source = requireNotNull(UploadAttachments.ownedPreparedFile(context, uri)) {
            "The selected file must be prepared before it is queued."
        }
        val jobDirectory = directory(key)
        check(jobDirectory.exists() || jobDirectory.mkdirs()) { "Could not create the upload source directory." }
        val destination = File(jobDirectory, "$index.source")
        moveReplacing(source, destination)
        UploadAttachments.preparedDirectory(context).takeIf { it.listFiles().isNullOrEmpty() }?.delete()
        return Uri.fromFile(destination).toString()
    }

    fun restore(context: Context, key: String, attachments: List<UploadAttachment>) {
        val jobDirectory = directory(key)
        attachments.forEachIndexed { index, attachment ->
            val original = requireNotNull(UploadAttachments.ownedPreparedFile(context, attachment.uri)) {
                "The selected file must be prepared before it is queued."
            }
            val adopted = File(jobDirectory, "$index.source")
            if (adopted.exists()) {
                val parent = checkNotNull(original.parentFile)
                check(parent.exists() || parent.mkdirs()) { "Could not restore the upload cache." }
                moveReplacing(adopted, original)
            }
        }
    }

    fun deleteSource(key: String, sourceUri: String) {
        val jobDirectory = directory(key).canonicalFile
        val source = sourceUri.toUri()
        val candidate = source.path?.let(::File)?.canonicalFile
        if (source.scheme == ContentResolver.SCHEME_FILE && candidate?.parentFile == jobDirectory) {
            candidate.delete()
        }
    }

    fun deleteAll(key: String) {
        directory(key).deleteRecursively()
    }

    fun directory(key: String): File {
        validateUploadKey(key)
        return File(directory, key)
    }
}

private fun validateUploadKey(key: String) {
    val parsed = runCatching { UUID.fromString(key) }.getOrNull()
    require(parsed?.toString() == key) { "Invalid upload work key." }
}

private fun moveReplacing(source: File, destination: File) {
    try {
        Files.move(
            source.toPath(),
            destination.toPath(),
            StandardCopyOption.ATOMIC_MOVE,
            StandardCopyOption.REPLACE_EXISTING
        )
    } catch (_: AtomicMoveNotSupportedException) {
        Files.move(source.toPath(), destination.toPath(), StandardCopyOption.REPLACE_EXISTING)
    }
}
