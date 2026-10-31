package dev.pneumo.app.transfer

import android.content.ContentResolver
import android.content.Context
import android.database.Cursor
import android.net.Uri
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import java.io.File
import java.io.FileOutputStream
import java.util.Locale
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext

/** Stable metadata and a readable source for one file upload. */
data class UploadAttachment(val uri: Uri, val name: String, val mime: String, val size: Long)

object UploadAttachments {
    /** Copies every source before Send; workers never depend on caller-owned URI grants. */
    suspend fun prepare(context: Context, uris: List<Uri>, fallbackMime: String? = null): List<UploadAttachment> {
        val applicationContext = context.applicationContext
        val prepared = ArrayList<UploadAttachment>(uris.size)
        var delivered = false
        try {
            withContext(Dispatchers.IO) {
                uris.forEach { uri ->
                    prepared += prepareOne(applicationContext, uri, fallbackMime)
                }
            }
            delivered = true
            return prepared
        } finally {
            if (!delivered) discardPrepared(applicationContext, prepared)
        }
    }

    fun discard(context: Context, attachments: List<UploadAttachment>) {
        discardPrepared(context.applicationContext, attachments)
    }

    private suspend fun prepareOne(context: Context, uri: Uri, fallbackMime: String?): UploadAttachment {
        val resolver = context.contentResolver
        val metadata = resolver.metadata(uri)
        val name = metadata.name?.takeIf(String::isNotBlank)
            ?: uri.lastPathSegment?.substringAfterLast('/')?.takeIf(String::isNotBlank)
            ?: DEFAULT_NAME
        val mime = resolver.concreteType(uri)
            ?: fallbackMime?.takeIf(::isConcreteMime)
            ?: mimeFromName(name)
            ?: DEFAULT_MIME

        val directory = preparedDirectory(context)
        check(directory.exists() || directory.mkdirs()) { "Could not create the upload cache." }
        val destination = File(directory, "${UUID.randomUUID()}.source")
        var complete = false
        return try {
            val size = resolver.openInputStream(uri)?.use { input ->
                FileOutputStream(destination).use { output -> copySource(input, output) }
            } ?: throw IllegalArgumentException("The selected file cannot be read.")
            require(metadata.size == null || metadata.size == size) {
                "The selected file changed while it was being prepared."
            }
            UploadAttachment(Uri.fromFile(destination), name, mime, size).also { complete = true }
        } finally {
            if (!complete) destination.delete()
        }
    }

    private fun ContentResolver.concreteType(uri: Uri): String? = try {
        getType(uri)?.takeIf(::isConcreteMime)
    } catch (_: IllegalArgumentException) {
        null
    } catch (_: UnsupportedOperationException) {
        null
    }

    private fun isConcreteMime(value: String): Boolean = value.isNotBlank() && '/' in value && '*' !in value

    private fun mimeFromName(name: String): String? {
        val extension = name.substringAfterLast('.', missingDelimiterValue = "")
            .lowercase(Locale.ROOT)
            .takeIf(String::isNotBlank)
            ?: return null
        return MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension)?.takeIf(::isConcreteMime)
    }

    private fun ContentResolver.metadata(uri: Uri): SourceMetadata = try {
        query(uri, METADATA_COLUMNS, null, null, null)?.use(::readMetadata) ?: SourceMetadata()
    } catch (_: IllegalArgumentException) {
        // File URIs and some document providers do not implement metadata queries.
        SourceMetadata()
    } catch (_: UnsupportedOperationException) {
        // The stream remains usable even when metadata lookup is unsupported.
        SourceMetadata()
    }

    private fun discardPrepared(context: Context, attachments: List<UploadAttachment>) {
        attachments.forEach { attachment ->
            ownedPreparedFile(context, attachment.uri)?.delete()
        }
        preparedDirectory(context).takeIf { it.listFiles().isNullOrEmpty() }?.delete()
    }

    internal fun ownedPreparedFile(context: Context, uri: Uri): File? {
        val path = uri.path
        return if (uri.scheme != ContentResolver.SCHEME_FILE || path == null) {
            null
        } else {
            val root = preparedDirectory(context).canonicalFile
            File(path).canonicalFile.takeIf { it.parentFile == root }
        }
    }

    internal fun preparedDirectory(context: Context): File = File(context.cacheDir, PREPARED_DIRECTORY)

    private const val PREPARED_DIRECTORY = "upload_sources"
    private const val DEFAULT_NAME = "attachment"
    private const val DEFAULT_MIME = "application/octet-stream"
    private val METADATA_COLUMNS = arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)
}
private suspend fun copySource(input: java.io.InputStream, output: java.io.OutputStream): Long {
    val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
    var total = 0L
    while (true) {
        currentCoroutineContext().ensureActive()
        val count = input.read(buffer)
        if (count < 0) return total
        output.write(buffer, 0, count)
        total += count.toLong()
    }
}

private data class SourceMetadata(val name: String? = null, val size: Long? = null)

private fun readMetadata(cursor: Cursor): SourceMetadata {
    if (!cursor.moveToFirst()) return SourceMetadata()
    val nameColumn = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
    val sizeColumn = cursor.getColumnIndex(OpenableColumns.SIZE)
    val name = nameColumn.takeIf { it >= 0 && !cursor.isNull(it) }?.let(cursor::getString)
    val size = sizeColumn.takeIf { it >= 0 && !cursor.isNull(it) }
        ?.let(cursor::getLong)
        ?.takeIf { it >= 0L }
    return SourceMetadata(name, size)
}
