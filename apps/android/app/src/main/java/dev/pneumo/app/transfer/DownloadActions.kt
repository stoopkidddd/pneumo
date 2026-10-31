package dev.pneumo.app.transfer

import android.app.Activity
import android.app.PendingIntent
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import dev.pneumo.app.notify.DownloadOpenActivity
import dev.pneumo.app.notify.NotificationIntents
import java.util.Locale

object DownloadActions {
    fun open(context: Context, uri: Uri, mime: String) {
        start(context, openIntent(context, uri, mime))
    }

    fun share(context: Context, uri: Uri, mime: String) {
        start(context, shareIntent(context, uri, mime))
    }

    internal fun openPendingIntent(context: Context, pushId: String, uri: Uri, mime: String): PendingIntent =
        PendingIntent.getActivity(
            context,
            0,
            Intent(Intent.ACTION_VIEW, uri, context, DownloadOpenActivity::class.java)
                .setDataAndType(uri, fileMime(context, uri, mime))
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                .putExtra(NotificationIntents.EXTRA_PUSH_ID, pushId),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

    internal fun sharePendingIntent(context: Context, uri: Uri, mime: String): PendingIntent =
        PendingIntent.getActivity(
            context,
            0,
            shareIntent(context, uri, mime).setData(identity("share", uri)),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

    private fun openIntent(context: Context, uri: Uri, mime: String): Intent = Intent(Intent.ACTION_VIEW)
        .setDataAndType(uri, fileMime(context, uri, mime))
        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)

    private fun shareIntent(context: Context, uri: Uri, mime: String): Intent {
        val send = Intent(Intent.ACTION_SEND)
            .setType(fileMime(context, uri, mime))
            .putExtra(Intent.EXTRA_STREAM, uri)
            .apply { clipData = ClipData.newRawUri("Pneumo file", uri) }
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        return Intent.createChooser(send, null)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }

    private fun start(context: Context, intent: Intent) {
        if (context !is Activity) intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            context.startActivity(intent)
        } catch (_: ActivityNotFoundException) {
            // Some devices have no app that can open this MIME type.
        } catch (_: SecurityException) {
            // The target can disappear or reject the one-time URI grant between resolution and launch.
        }
    }

    private fun fileMime(context: Context, uri: Uri, supplied: String): String {
        if (supplied.isNotBlank() && supplied != DEFAULT_MIME && '*' !in supplied) return supplied
        val name = runCatching {
            context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) cursor.getString(0) else null
            }
        }.getOrNull()
        val extension = name?.substringAfterLast('.', "")?.lowercase(Locale.ROOT)
        return extension?.let { MimeTypeMap.getSingleton().getMimeTypeFromExtension(it) } ?: DEFAULT_MIME
    }

    private const val DEFAULT_MIME = "application/octet-stream"

    private fun identity(action: String, uri: Uri): Uri = Uri.Builder()
        .scheme("pneumo")
        .authority("download")
        .appendPath(action)
        .appendQueryParameter("uri", uri.toString())
        .build()
}
