package dev.pneumo.app.notify

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class DismissReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_DISMISS) return
        val pushId = intent.getStringExtra(NotificationIntents.EXTRA_PUSH_ID) ?: return
        PushNotificationGroup.cancelChild(context, pushId)
    }

    companion object {
        internal const val ACTION_DISMISS = "dev.pneumo.app.notify.DISMISS"
    }
}
