package dev.pneumo.app.notify

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import dev.pneumo.app.transfer.DownloadActions

class DownloadOpenActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val uri = intent.data
        val mime = intent.type
        val pushId = intent.getStringExtra(NotificationIntents.EXTRA_PUSH_ID)
        val hasFile = uri?.scheme == "content" && mime != null && pushId != null
        if (intent.action == Intent.ACTION_VIEW && hasFile) {
            PushNotificationGroup.cancelChild(this, checkNotNull(pushId))
            DownloadActions.open(this, checkNotNull(uri), checkNotNull(mime))
        }
        finish()
    }
}
