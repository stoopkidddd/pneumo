package dev.pneumo.app.notify

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.text.format.Formatter
import androidx.compose.ui.graphics.toArgb
import androidx.core.net.toUri
import dev.pneumo.app.MainActivity
import dev.pneumo.app.R
import dev.pneumo.app.crypto.PushCrypto
import dev.pneumo.app.protocol.FilePayload
import dev.pneumo.app.protocol.LinkPayload
import dev.pneumo.app.protocol.NotePayload
import dev.pneumo.app.protocol.PushDTO
import dev.pneumo.app.protocol.PushPayload
import dev.pneumo.app.sync.PushSink
import dev.pneumo.app.ui.theme.BrandColors
import java.time.Instant
import javax.crypto.SecretKey

class PushNotifier(private val context: Context, private val ownDeviceId: String, private val contentKey: SecretKey) :
    PushSink {
    private val manager = context.getSystemService(NotificationManager::class.java)

    init {
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                context.getString(R.string.notification_channel_pushes),
                NotificationManager.IMPORTANCE_HIGH
            )
        )
    }

    override suspend fun accept(push: PushDTO) {
        if (!push.isEligible() || !context.canPostNotifications()) return

        val payload = PushCrypto.decrypt(contentKey, push.id, push.envelope)
        val notification = notification(push, payload)
        try {
            manager.notify(push.id, push.id.hashCode(), notification)
            PushNotificationGroup.reconcile(context)
        } catch (_: SecurityException) {
            // Notification permission can be revoked between the check and notify().
        }
    }

    override suspend fun cancel(pushId: String) {
        PushNotificationGroup.cancelChild(context, pushId)
    }

    private fun notification(push: PushDTO, payload: PushPayload): Notification {
        val builder = Notification.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(BrandColors.Light.Accent.toArgb())
            .setContentIntent(NotificationIntents.openPush(context, push.id))
            .setDeleteIntent(NotificationIntents.dismiss(context, push.id))
            .setAutoCancel(true)
            .setCategory(Notification.CATEGORY_MESSAGE)
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .setGroup(PushNotificationGroup.GROUP_KEY)
            .setWhen(Instant.parse(push.createdAt).toEpochMilli())
            .setShowWhen(true)

        when (payload) {
            is NotePayload ->
                builder
                    .setContentTitle(payload.title ?: context.getString(R.string.notification_note_title))
                    .setContentText(payload.body)
                    .setStyle(Notification.BigTextStyle().bigText(payload.body))
                    .addAction(
                        action(
                            R.string.notification_action_copy,
                            NotificationIntents.copy(context, push.id, payload.body)
                        )
                    )

            is LinkPayload ->
                builder
                    .setContentTitle(payload.title ?: payload.url.toUri().host.orEmpty())
                    .setContentText(payload.url)
                    .apply {
                        NotificationIntents.openUrl(context, push.id, payload.url)?.let { open ->
                            addAction(action(R.string.notification_action_open, open))
                        }
                    }
                    .addAction(
                        action(
                            R.string.notification_action_copy,
                            NotificationIntents.copy(context, push.id, payload.url)
                        )
                    )

            is FilePayload ->
                builder
                    .setContentTitle(payload.file.name)
                    .setContentText(fileText(payload))
                    .addAction(
                        action(
                            R.string.notification_action_download,
                            NotificationIntents.download(context, push.id)
                        )
                    )
        }
        return builder.build()
    }

    private fun action(title: Int, intent: PendingIntent): Notification.Action =
        Notification.Action.Builder(null, context.getString(title), intent).build()

    private fun fileText(payload: FilePayload): String {
        val size = Formatter.formatShortFileSize(context, payload.file.size)
        return payload.body?.takeIf(String::isNotEmpty)?.let { "$size • $it" } ?: size
    }

    private fun PushDTO.isEligible(): Boolean =
        sourceDeviceId != ownDeviceId && (targetDeviceId == null || targetDeviceId == ownDeviceId)

    companion object {
        const val CHANNEL_ID = "pushes"
    }
}

internal object NotificationIntents {
    const val EXTRA_PUSH_ID = MainActivity.EXTRA_PUSH_ID
    const val EXTRA_TEXT = "text"

    fun openPush(context: Context, pushId: String): PendingIntent = PendingIntent.getActivity(
        context,
        0,
        Intent(context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .setData(identity("body", pushId))
            .putExtra(EXTRA_PUSH_ID, pushId),
        FLAGS
    )

    fun copy(context: Context, pushId: String, text: String): PendingIntent = PendingIntent.getBroadcast(
        context,
        0,
        Intent(context, CopyReceiver::class.java)
            .setAction(CopyReceiver.ACTION_COPY)
            .setData(identity("copy", pushId))
            .putExtra(EXTRA_PUSH_ID, pushId)
            .putExtra(EXTRA_TEXT, text),
        FLAGS
    )

    fun openUrl(context: Context, pushId: String, url: String): PendingIntent? {
        val uri = url.toUri()
        if (!uri.isSafeHttpUrl()) return null
        return PendingIntent.getActivity(
            context,
            0,
            Intent(Intent.ACTION_VIEW, uri, context, OpenActivity::class.java)
                .addCategory("dev.pneumo.app.notify.identity.open.$pushId")
                .putExtra(EXTRA_PUSH_ID, pushId),
            FLAGS
        )
    }

    fun download(context: Context, pushId: String): PendingIntent = PendingIntent.getBroadcast(
        context,
        0,
        Intent(context, DownloadRequestedReceiver::class.java)
            .setAction(DownloadRequestedReceiver.ACTION_DOWNLOAD)
            .setData(identity("download", pushId))
            .putExtra(EXTRA_PUSH_ID, pushId),
        FLAGS
    )

    fun dismiss(context: Context, pushId: String): PendingIntent = PendingIntent.getBroadcast(
        context,
        0,
        Intent(context, DismissReceiver::class.java)
            .setAction(DismissReceiver.ACTION_DISMISS)
            .setData(identity("dismiss", pushId))
            .putExtra(EXTRA_PUSH_ID, pushId),
        FLAGS
    )

    private fun identity(action: String, pushId: String): Uri = Uri.Builder()
        .scheme("pneumo")
        .authority("notification")
        .appendPath(action)
        .appendPath(pushId)
        .build()

    private const val FLAGS = PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
}

internal object PushNotificationGroup {
    const val GROUP_KEY = "dev.pneumo.app.PUSHES"
    const val SUMMARY_TAG = "pushes-summary"
    private const val SUMMARY_ID = 1
    private const val SUMMARY_THRESHOLD = 3

    fun cancelChild(context: Context, pushId: String) {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.cancel(pushId, pushId.hashCode())
        reconcile(context)
    }

    fun reconcile(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        val childCount = manager.activeNotifications.count { status ->
            status.tag != SUMMARY_TAG &&
                status.notification.channelId == PushNotifier.CHANNEL_ID &&
                status.notification.group == GROUP_KEY &&
                status.notification.flags and Notification.FLAG_GROUP_SUMMARY == 0
        }
        if (childCount < SUMMARY_THRESHOLD) {
            manager.cancel(SUMMARY_TAG, SUMMARY_ID)
            return
        }
        val openApp = PendingIntent.getActivity(
            context,
            0,
            Intent(context, MainActivity::class.java)
                .setData("pneumo://notification/group".toUri()),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val summary = Notification.Builder(context, PushNotifier.CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(BrandColors.Light.Accent.toArgb())
            .setContentTitle(context.getString(R.string.app_name))
            .setContentText(
                context.resources.getQuantityString(R.plurals.notification_group_count, childCount, childCount)
            )
            .setContentIntent(openApp)
            .setGroup(GROUP_KEY)
            .setGroupSummary(true)
            .setOnlyAlertOnce(true)
            .build()
        try {
            manager.notify(SUMMARY_TAG, SUMMARY_ID, summary)
        } catch (_: SecurityException) {
            // Notification permission can be revoked while active notifications are reconciled.
        }
    }
}

private fun Context.canPostNotifications(): Boolean = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
    checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
