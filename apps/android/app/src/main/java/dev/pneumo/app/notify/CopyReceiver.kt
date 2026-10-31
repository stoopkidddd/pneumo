package dev.pneumo.app.notify

import android.content.BroadcastReceiver
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.widget.Toast
import dev.pneumo.app.R

class CopyReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val pushId = intent.getStringExtra(NotificationIntents.EXTRA_PUSH_ID)
        val text = intent.getStringExtra(NotificationIntents.EXTRA_TEXT)
        if (intent.action != ACTION_COPY || pushId == null || text == null) return
        context.getSystemService(ClipboardManager::class.java)
            .setPrimaryClip(ClipData.newPlainText("Pneumo", text))
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            Toast.makeText(context, R.string.notification_copied, Toast.LENGTH_SHORT).show()
        }
        PushNotificationGroup.cancelChild(context, pushId)
    }

    companion object {
        internal const val ACTION_COPY = "dev.pneumo.app.notify.COPY"
    }
}
