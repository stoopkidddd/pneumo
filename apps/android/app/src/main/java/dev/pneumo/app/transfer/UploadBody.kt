package dev.pneumo.app.transfer

import android.content.ContentResolver
import android.content.Context
import android.net.Uri
import androidx.core.net.toUri
import dev.pneumo.app.crypto.FileCrypto
import java.io.File
import java.io.FilterInputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody
import okio.BufferedSink

private const val PERCENT_MAX = 100
internal class EncryptedUploadSource(
    val context: Context,
    val item: StoredUploadItem,
    val fileKey: ByteArray,
    val fileId: String
)

internal class EncryptedFileRequestBody(
    private val source: EncryptedUploadSource,
    private val progress: (Int) -> Unit
) : RequestBody() {
    override fun contentType() = OCTET_STREAM

    override fun contentLength(): Long = source.item.ciphertextSize

    override fun writeTo(sink: BufferedSink) {
        val rawInput = openSource(source.context, source.item.sourceUri.toUri())
        SourceInputStream(rawInput).use { input ->
            val output = ProgressOutputStream(sink.outputStream(), source.item.ciphertextSize, progress)
            FileCrypto.encrypt(input, output, source.fileKey, source.fileId)
            if (input.bytesRead != source.item.plaintextSize ||
                output.bytesWritten != source.item.ciphertextSize
            ) {
                throw UploadSourceException()
            }
        }
    }
}

private class SourceInputStream(input: InputStream) : FilterInputStream(input) {
    var bytesRead: Long = 0L
        private set

    override fun read(): Int = sourceRead { super.read() }.also { if (it >= 0) bytesRead += 1L }

    override fun read(buffer: ByteArray, offset: Int, length: Int): Int =
        sourceRead { super.read(buffer, offset, length) }.also { if (it > 0) bytesRead += it.toLong() }

    private inline fun sourceRead(block: () -> Int): Int = try {
        block()
    } catch (failure: IOException) {
        throw UploadSourceException(failure)
    } catch (failure: SecurityException) {
        throw UploadSourceException(failure)
    }
}

private class ProgressOutputStream(
    private val output: OutputStream,
    private val expectedBytes: Long,
    private val progress: (Int) -> Unit
) : OutputStream() {
    var bytesWritten: Long = 0L
        private set
    private var lastPercent = -1

    override fun write(value: Int) {
        output.write(value)
        advanced(1)
    }

    override fun write(buffer: ByteArray, offset: Int, length: Int) {
        output.write(buffer, offset, length)
        advanced(length)
    }

    override fun flush() = output.flush()

    private fun advanced(count: Int) {
        bytesWritten += count.toLong()
        val percent = if (expectedBytes == 0L) {
            PERCENT_MAX
        } else {
            ((bytesWritten.coerceAtMost(expectedBytes) * PERCENT_MAX) / expectedBytes).toInt()
        }
        if (percent != lastPercent) {
            lastPercent = percent
            progress(percent)
        }
    }
}

private fun openSource(context: Context, source: Uri): InputStream = try {
    if (source.scheme == ContentResolver.SCHEME_FILE) {
        File(source.path ?: throw UploadSourceException()).inputStream()
    } else {
        context.contentResolver.openInputStream(source) ?: throw UploadSourceException()
    }
} catch (failure: UploadSourceException) {
    throw failure
} catch (failure: IOException) {
    throw UploadSourceException(failure)
} catch (failure: SecurityException) {
    throw UploadSourceException(failure)
}
private val OCTET_STREAM = "application/octet-stream".toMediaType()
