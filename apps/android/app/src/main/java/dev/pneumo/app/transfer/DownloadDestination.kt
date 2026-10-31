package dev.pneumo.app.transfer

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import androidx.annotation.RequiresApi
import androidx.core.content.FileProvider
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.OutputStream

internal interface DownloadDestination {
    val uri: Uri
    fun openOutput(): OutputStream
    fun complete()
    fun delete()
}

internal fun interface DownloadDestinationFactory {
    fun create(name: String, mime: String): DownloadDestination
}

internal class AndroidDownloadDestinationFactory(private val context: Context) : DownloadDestinationFactory {
    override fun create(name: String, mime: String): DownloadDestination =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            createMediaStore(name, mime)
        } else {
            createExternalFile(name)
        }

    @RequiresApi(Build.VERSION_CODES.Q)
    private fun createMediaStore(requestedName: String, mime: String): DownloadDestination {
        val resolver = context.contentResolver
        val relativePath = "${Environment.DIRECTORY_DOWNLOADS}/$PNEUMO_DIRECTORY/"
        val name = collisionName(safeName(requestedName)) { candidate ->
            resolver.query(
                MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                arrayOf(MediaStore.Downloads._ID),
                "${MediaStore.Downloads.RELATIVE_PATH} = ? AND ${MediaStore.Downloads.DISPLAY_NAME} = ?",
                arrayOf(relativePath, candidate),
                null
            )?.use { it.moveToFirst() } == true
        }
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, name)
            put(MediaStore.Downloads.MIME_TYPE, mime)
            put(MediaStore.Downloads.RELATIVE_PATH, relativePath)
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
            ?: throw IOException("Could not create download")
        return object : DownloadDestination {
            override val uri: Uri = uri

            override fun openOutput(): OutputStream = resolver.openOutputStream(uri, "w")
                ?: throw IOException("Could not open download")

            override fun complete() {
                val completed = ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }
                if (resolver.update(uri, completed, null, null) != 1) {
                    throw IOException("Could not publish download")
                }
            }

            override fun delete() {
                resolver.delete(uri, null, null)
            }
        }
    }

    private fun createExternalFile(requestedName: String): DownloadDestination {
        val directory = externalDownloadsDirectory()
        val file = File(directory, collisionName(safeName(requestedName)) { File(directory, it).exists() })
        if (!file.createNewFile()) throw IOException("Could not create download")
        val uri = fileProviderUri(file)
        return object : DownloadDestination {
            override val uri: Uri = uri

            override fun openOutput(): OutputStream = FileOutputStream(file, false)

            override fun complete() = Unit

            override fun delete() {
                file.delete()
            }
        }
    }

    private fun externalDownloadsDirectory(): File {
        val downloads = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS)
            ?: throw IOException("External downloads are unavailable")
        val directory = File(downloads, PNEUMO_DIRECTORY)
        if (!directory.isDirectory && !directory.mkdirs()) {
            throw IOException("Could not create downloads directory")
        }
        return directory
    }

    private fun fileProviderUri(file: File): Uri {
        var created = false
        try {
            return FileProvider.getUriForFile(context, "${context.packageName}.files", file)
                .also { created = true }
        } finally {
            if (!created) file.delete()
        }
    }

    private fun safeName(requestedName: String): String {
        val leaf = requestedName.substringAfterLast('/').substringAfterLast('\\')
            .replace('\u0000', '_')
            .trim()
        return leaf.takeIf { it.isNotEmpty() && it != "." && it != ".." } ?: DEFAULT_NAME
    }

    private fun collisionName(name: String, exists: (String) -> Boolean): String {
        if (!exists(name)) return name
        val dot = name.lastIndexOf('.')
        val hasExtension = dot > 0 && dot < name.lastIndex
        val stem = if (hasExtension) name.substring(0, dot) else name
        val extension = if (hasExtension) name.substring(dot) else ""
        var index = 1
        while (true) {
            val candidate = "$stem ($index)$extension"
            if (!exists(candidate)) return candidate
            index += 1
        }
    }

    private companion object {
        const val PNEUMO_DIRECTORY = "Pneumo"
        const val DEFAULT_NAME = "download"
    }
}
