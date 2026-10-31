package dev.pneumo.app.notify

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

class OpenActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val pushId = intent.getStringExtra(NotificationIntents.EXTRA_PUSH_ID)
        val url = intent.data
        if (intent.action == Intent.ACTION_VIEW && pushId != null && url.isSafeHttpUrl()) {
            PushNotificationGroup.cancelChild(this, pushId)
            try {
                startActivity(Intent(Intent.ACTION_VIEW, url).addCategory(Intent.CATEGORY_BROWSABLE))
            } catch (_: ActivityNotFoundException) {
                // The notification was handled even when the device has no browser.
            }
        }
        finish()
    }
}

internal fun Uri?.isSafeHttpUrl(): Boolean {
    val rawUrl = this?.toString() ?: return false
    return rawUrl.none { it.isWhitespace() } && rawUrl.toHttpUrlOrNull() != null
}
