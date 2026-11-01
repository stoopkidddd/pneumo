package dev.pneumo.app.notify

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import dev.pneumo.app.transfer.DownloadActions

class DownloadShareActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val uri = intent.data
        val mime = intent.type
        if (intent.action == Intent.ACTION_SEND && uri?.scheme == "content" && mime != null) {
            DownloadActions.share(this, uri, mime)
        }
        finish()
    }
}
