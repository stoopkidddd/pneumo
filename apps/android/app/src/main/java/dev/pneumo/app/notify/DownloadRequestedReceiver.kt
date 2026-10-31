package dev.pneumo.app.notify

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import android.widget.Toast
import dev.pneumo.app.R

class DownloadRequestedReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_DOWNLOAD) return
        val pushId = intent.getStringExtra(NotificationIntents.EXTRA_PUSH_ID) ?: return
        Log.i(TAG, pushId)
        Toast.makeText(context, R.string.notification_download_coming_soon, Toast.LENGTH_SHORT).show()
    }

    companion object {
        internal const val ACTION_DOWNLOAD = "dev.pneumo.app.notify.DOWNLOAD"
        private const val TAG = "DownloadRequested"
    }
}
