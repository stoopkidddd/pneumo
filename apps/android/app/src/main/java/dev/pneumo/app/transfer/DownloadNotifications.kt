package dev.pneumo.app.transfer

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.Build
import androidx.compose.ui.graphics.toArgb
import androidx.work.ForegroundInfo
import dev.pneumo.app.R
import dev.pneumo.app.notify.NotificationIntents
import dev.pneumo.app.notify.PushNotificationGroup
import dev.pneumo.app.notify.PushNotifier
import dev.pneumo.app.ui.theme.BrandColors

internal class DownloadNotifications(private val context: Context, private val pushId: String) {
    private val manager = context.getSystemService(NotificationManager::class.java)

    init {
        manager.createNotificationChannel(
            NotificationChannel(TRANSFER_CHANNEL, "Transfers", NotificationManager.IMPORTANCE_LOW)
        )
        manager.createNotificationChannel(
            NotificationChannel(
                PushNotifier.CHANNEL_ID,
                context.getString(R.string.notification_channel_pushes),
                NotificationManager.IMPORTANCE_HIGH
            )
        )
    }

    fun foreground(progress: Int?): ForegroundInfo {
        val notification = Notification.Builder(context, TRANSFER_CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(BrandColors.Light.Accent.toArgb())
            .setContentTitle("Downloading file")
            .setCategory(Notification.CATEGORY_PROGRESS)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setProgress(PROGRESS_MAX, progress ?: 0, progress == null)
            .build()
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ForegroundInfo(foregroundId(), notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            ForegroundInfo(foregroundId(), notification)
        }
    }

    fun postDownloading(name: String, progress: Int?) = post(downloading(name, progress))

    internal fun downloading(name: String, progress: Int?): Notification = base(name)
        .setContentText(progress?.let { "Downloading… $it%" } ?: "Downloading…")
        .setProgress(PROGRESS_MAX, progress ?: 0, progress == null)
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .build()

    fun postComplete(name: String, uri: Uri, mime: String) = post(complete(name, uri, mime))

    internal fun complete(name: String, uri: Uri, mime: String): Notification {
        val open = DownloadActions.openPendingIntent(context, pushId, uri, mime)
        val share = DownloadActions.sharePendingIntent(context, uri, mime)
        return base(name)
            .setContentText("Download complete")
            .setAutoCancel(true)
            .addAction(Notification.Action.Builder(null, "Open", open).build())
            .addAction(Notification.Action.Builder(null, "Share", share).build())
            .build()
    }

    fun postFailed(name: String, message: String) = post(failed(name, message))

    internal fun failed(name: String, message: String): Notification = base(name)
        .setContentText(message)
        .setStyle(Notification.BigTextStyle().bigText(message))
        .addAction(
            Notification.Action.Builder(
                null,
                "Download",
                NotificationIntents.download(context, pushId)
            ).build()
        )
        .build()

    private fun base(name: String): Notification.Builder = Notification.Builder(context, PushNotifier.CHANNEL_ID)
        .setSmallIcon(R.drawable.ic_notification)
        .setColor(BrandColors.Light.Accent.toArgb())
        .setContentTitle(name)
        .setContentIntent(NotificationIntents.openPush(context, pushId))
        .setDeleteIntent(NotificationIntents.dismiss(context, pushId))
        .setCategory(Notification.CATEGORY_MESSAGE)
        .setVisibility(Notification.VISIBILITY_PRIVATE)
        .setGroup(PushNotificationGroup.GROUP_KEY)

    private fun post(notification: Notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            return
        }
        try {
            PushNotificationGroup.post(context, pushId, notification)
        } catch (_: SecurityException) {
            // Notification permission can be revoked between the check and notify().
        }
    }

    private fun foregroundId(): Int = pushId.hashCode() xor FOREGROUND_ID_MASK

    private companion object {
        const val TRANSFER_CHANNEL = "transfers"
        const val PROGRESS_MAX = 100
        const val FOREGROUND_ID_MASK = 0x4d2f19a7
    }
}
