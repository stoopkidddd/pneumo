package dev.pneumo.app.transfer

import android.app.Application
import android.content.Intent
import android.net.Uri
import android.os.Environment
import androidx.core.content.FileProvider
import androidx.test.core.app.ApplicationProvider
import dev.pneumo.app.notify.DownloadOpenActivity
import dev.pneumo.app.notify.NotificationIntents
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class DownloadActionsTest {
    private val context = ApplicationProvider.getApplicationContext<Application>()
    private val uri = Uri.parse("content://dev.pneumo.app.files/downloads/report.pdf")

    @Test
    fun openActionViewsExactContentUriWithReadGrant() {
        val intent = shadowOf(
            DownloadActions.openPendingIntent(context, PUSH_ID, uri, "application/pdf")
        ).savedIntent

        assertEquals(Intent.ACTION_VIEW, intent.action)
        assertEquals(DownloadOpenActivity::class.java.name, intent.component?.className)
        assertEquals(PUSH_ID, intent.getStringExtra(NotificationIntents.EXTRA_PUSH_ID))
        assertEquals(uri, intent.data)
        assertEquals("application/pdf", intent.type)
        assertTrue(intent.flags and Intent.FLAG_GRANT_READ_URI_PERMISSION != 0)
    }

    @Test
    fun shareActionChoosesSendWithStreamClipAndReadGrant() {
        val chooser = shadowOf(
            DownloadActions.sharePendingIntent(context, uri, "application/pdf")
        ).savedIntent
        val send = chooser.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
            ?: throw AssertionError("Missing chooser target")

        assertEquals(Intent.ACTION_CHOOSER, chooser.action)
        assertEquals(Intent.ACTION_SEND, send.action)
        assertEquals("application/pdf", send.type)
        assertEquals(uri, send.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java))
        assertEquals(uri, send.clipData?.getItemAt(0)?.uri)
        assertTrue(send.flags and Intent.FLAG_GRANT_READ_URI_PERMISSION != 0)
    }

    @Test
    fun genericDownloadTypeUsesDisplayNameForViewerButDoesNotOverrideSpecificType() {
        val directory = File(context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "Pneumo")
        check(directory.exists() || directory.mkdirs())
        val image = File(directory, "download.PNG")
        image.writeBytes(byteArrayOf())
        try {
            val contentUri = FileProvider.getUriForFile(context, "${context.packageName}.files", image)
            val inferred = shadowOf(
                DownloadActions.openPendingIntent(context, PUSH_ID, contentUri, "application/octet-stream")
            ).savedIntent
            assertEquals("image/png", inferred.type)
            assertEquals(contentUri, inferred.data)
            val explicit = shadowOf(
                DownloadActions.openPendingIntent(context, PUSH_ID, contentUri, "application/pdf")
            ).savedIntent
            assertEquals("application/pdf", explicit.type)
        } finally {
            image.delete()
        }
    }

    private companion object {
        const val PUSH_ID = "018f0c6e-7a00-7000-8000-000000000002"
    }
}
