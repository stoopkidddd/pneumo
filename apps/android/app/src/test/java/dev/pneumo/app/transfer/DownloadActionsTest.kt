package dev.pneumo.app.transfer

import android.app.Application
import android.app.PendingIntent
import android.content.Intent
import android.net.Uri
import android.os.Environment
import androidx.core.content.FileProvider
import androidx.core.content.IntentCompat
import androidx.test.core.app.ApplicationProvider
import dev.pneumo.app.notify.DownloadOpenActivity
import dev.pneumo.app.notify.DownloadShareActivity
import dev.pneumo.app.notify.NotificationIntents
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
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
        val chooser = launchShare(DownloadActions.sharePendingIntent(context, uri, "application/pdf"))
        val send = IntentCompat.getParcelableExtra(chooser, Intent.EXTRA_INTENT, Intent::class.java)
            ?: throw AssertionError("Missing chooser target")

        assertEquals(Intent.ACTION_CHOOSER, chooser.action)
        assertNull(chooser.data)
        assertTrue(chooser.flags and Intent.FLAG_GRANT_READ_URI_PERMISSION != 0)
        assertEquals(Intent.ACTION_SEND, send.action)
        assertEquals("application/pdf", send.type)
        assertEquals(uri, IntentCompat.getParcelableExtra(send, Intent.EXTRA_STREAM, Uri::class.java))
        assertEquals(uri, send.clipData?.getItemAt(0)?.uri)
        assertTrue(send.flags and Intent.FLAG_GRANT_READ_URI_PERMISSION != 0)
    }

    @Test
    @Config(sdk = [26, 34])
    fun shareActionsKeepEachFileWhenAnotherDownloadCompletes() {
        val otherUri = Uri.parse("content://dev.pneumo.app.files/downloads/photo.png")
        val first = DownloadActions.sharePendingIntent(context, uri, "application/pdf")
        val second = DownloadActions.sharePendingIntent(context, otherUri, "image/png")

        assertNotEquals(first, second)
        val targets = listOf(
            Triple(first, uri, "application/pdf"),
            Triple(second, otherUri, "image/png")
        )
        for ((pending, expectedUri, expectedMime) in targets) {
            val chooser = launchShare(pending)
            val send = checkNotNull(IntentCompat.getParcelableExtra(chooser, Intent.EXTRA_INTENT, Intent::class.java))
            assertEquals(Intent.ACTION_CHOOSER, chooser.action)
            assertNull(chooser.data)
            assertEquals(expectedUri, IntentCompat.getParcelableExtra(send, Intent.EXTRA_STREAM, Uri::class.java))
            assertEquals(expectedMime, send.type)
        }
    }

    private fun launchShare(pending: PendingIntent): Intent {
        pending.send()
        val launched = shadowOf(context).nextStartedActivity
        if (launched.action == Intent.ACTION_CHOOSER) return launched
        assertNotNull(launched.resolveActivity(context.packageManager))
        assertEquals(DownloadShareActivity::class.java.name, launched.component?.className)
        val controller = Robolectric.buildActivity(DownloadShareActivity::class.java, launched).create()
        try {
            assertTrue(controller.get().isFinishing)
            return checkNotNull(shadowOf(controller.get()).nextStartedActivity)
        } finally {
            controller.destroy()
        }
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
