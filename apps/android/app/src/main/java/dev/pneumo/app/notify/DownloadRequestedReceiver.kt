package dev.pneumo.app.notify

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import dev.pneumo.app.transfer.DownloadScheduler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

class DownloadRequestedReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_DOWNLOAD) return
        val pushId = intent.getStringExtra(NotificationIntents.EXTRA_PUSH_ID) ?: return
        val pendingResult = goAsync()
        CoroutineScope(SupervisorJob() + Dispatchers.Default).launch {
            try {
                DownloadScheduler.enqueue(context, pushId)
            } catch (_: Exception) {
                // A signed-out session or enqueue failure leaves the existing Download action available.
            } finally {
                pendingResult.finish()
            }
        }
    }

    companion object {
        internal const val ACTION_DOWNLOAD = "dev.pneumo.app.notify.DOWNLOAD"
    }
}
