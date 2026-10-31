package dev.pneumo.app.ui.share

import android.content.Context
import dev.pneumo.app.protocol.CreatePushRequest
import dev.pneumo.app.protocol.ProtocolJson
import java.io.File
import java.io.FileOutputStream
import java.util.UUID
import kotlinx.serialization.Serializable

@Serializable
internal data class StoredShareWork(val sessionDeviceId: String, val request: CreatePushRequest)

/** Stores a session association and server-ready request; envelope content is already AES-GCM encrypted. */
internal class ShareWorkStore(private val directory: File) {
    fun write(work: StoredShareWork): String {
        check(directory.exists() || directory.mkdirs()) { "Could not create the share work directory" }
        val key = UUID.randomUUID().toString()
        val destination = file(key)
        val temporary = File(directory, "$key.tmp")
        val serialized = ProtocolJson.encodeToString(StoredShareWork.serializer(), work)
            .toByteArray(Charsets.UTF_8)
        try {
            FileOutputStream(temporary).use { output ->
                output.write(serialized)
                output.fd.sync()
            }
            check(temporary.renameTo(destination)) { "Could not persist share work" }
            return key
        } finally {
            serialized.fill(0)
            temporary.delete()
        }
    }

    fun read(key: String): StoredShareWork = ProtocolJson.decodeFromString(
        StoredShareWork.serializer(),
        file(key).readText(Charsets.UTF_8)
    )

    fun delete(key: String) {
        try {
            file(key).delete()
        } catch (_: IllegalArgumentException) {
            // Invalid WorkManager input has no corresponding spool file.
        }
    }

    fun exists(key: String): Boolean = file(key).exists()

    private fun file(key: String): File {
        val parsed = runCatching { UUID.fromString(key) }.getOrNull()
        require(parsed?.toString() == key) { "Invalid share work key" }
        return File(directory, "$key.work")
    }

    companion object {
        fun create(context: Context): ShareWorkStore = ShareWorkStore(
            File(context.applicationContext.noBackupFilesDir, DIRECTORY)
        )

        private const val DIRECTORY = "share_work"
    }
}
