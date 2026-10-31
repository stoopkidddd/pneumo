package dev.pneumo.app.notify

import android.Manifest
import android.app.Application
import android.app.NotificationManager
import android.content.ClipboardManager
import android.content.Intent
import android.net.Uri
import android.os.Looper
import androidx.test.core.app.ApplicationProvider
import dev.pneumo.app.crypto.PushCrypto
import dev.pneumo.app.protocol.LinkPayload
import dev.pneumo.app.protocol.NotePayload
import dev.pneumo.app.protocol.PushDTO
import dev.pneumo.app.protocol.PushPayload
import javax.crypto.SecretKey
import javax.crypto.spec.SecretKeySpec
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowToast

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class NotificationActionsTest {
    private val context = ApplicationProvider.getApplicationContext<Application>()
    private val manager = context.getSystemService(NotificationManager::class.java)
    private val contentKey: SecretKey = SecretKeySpec(ByteArray(32) { it.toByte() }, "AES")

    @Before
    fun setUp() {
        manager.cancelAll()
        shadowOf(context).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
        ShadowToast.reset()
    }

    @Test
    @Config(sdk = [32])
    fun copyPreservesUnicodeMultilineTextCancelsChildAndToastsBeforeAndroid13() = runTest {
        val text = "Zażółć gęślą\n日本語 👋"
        post(ID_1, NotePayload(body = text))

        childAction(ID_1, "Copy").send()
        shadowOf(Looper.getMainLooper()).idle()

        val clip = context.getSystemService(ClipboardManager::class.java).primaryClip
        assertNotNull(clip)
        assertEquals("Pneumo", clip?.description?.label.toString())
        assertEquals(text, clip?.getItemAt(0)?.text.toString())
        assertNull(manager.activeNotifications.singleOrNull { it.tag == ID_1 })
        assertEquals("Copied", ShadowToast.getTextOfLatestToast())
    }

    @Test
    fun copyReliesOnSystemConfirmationAndDoesNotToastOnAndroid13OrLater() = runTest {
        val text = "line one\nline two ♫"
        post(ID_1, NotePayload(body = text))

        childAction(ID_1, "Copy").send()
        shadowOf(Looper.getMainLooper()).idle()

        assertEquals(
            text,
            context.getSystemService(ClipboardManager::class.java).primaryClip?.getItemAt(0)?.text.toString()
        )
        assertEquals(0, ShadowToast.shownToastCount())
        assertNull(manager.activeNotifications.singleOrNull { it.tag == ID_1 })
    }

    @Test
    fun openDispatcherCancelsChildReconcilesGroupAndForwardsOnlyHttpUrl() = runTest {
        post(ID_1, NotePayload(body = "One"))
        post(ID_2, NotePayload(body = "Two"))
        post(ID_3, NotePayload(body = "Three"))
        assertNotNull(manager.activeNotifications.singleOrNull { it.tag == PushNotificationGroup.SUMMARY_TAG })
        val url = "https://example.test/path?q=one"
        val intent = Intent(context, OpenActivity::class.java)
            .setAction(Intent.ACTION_VIEW)
            .setData(Uri.parse(url))
            .putExtra(NotificationIntents.EXTRA_PUSH_ID, ID_1)

        val controller = Robolectric.buildActivity(OpenActivity::class.java, intent).create()
        val forwarded = shadowOf(controller.get()).nextStartedActivity

        assertEquals(Intent.ACTION_VIEW, forwarded.action)
        assertEquals(Uri.parse(url), forwarded.data)
        assertNull(forwarded.component)
        assertNull(manager.activeNotifications.singleOrNull { it.tag == ID_1 })
        assertNotNull(manager.activeNotifications.singleOrNull { it.tag == PushNotificationGroup.SUMMARY_TAG })
        controller.destroy()
    }

    @Test
    fun openDispatcherRejectsNonHttpAndMalformedHttpUrlsWithoutCancelling() = runTest {
        post(ID_1, NotePayload(body = "Keep me"))
        for (url in listOf("javascript:alert(1)", "https://")) {
            val intent = Intent(context, OpenActivity::class.java)
                .setAction(Intent.ACTION_VIEW)
                .setData(Uri.parse(url))
                .putExtra(NotificationIntents.EXTRA_PUSH_ID, ID_1)
            val controller = Robolectric.buildActivity(OpenActivity::class.java, intent).create()

            assertNull(shadowOf(controller.get()).nextStartedActivity)
            assertNotNull(manager.activeNotifications.singleOrNull { it.tag == ID_1 })
            controller.destroy()
        }
    }

    @Test
    fun downloadActionShowsComingSoonAndKeepsNotification() = runTest {
        post(ID_1, LinkPayload(url = "https://example.test"))
        val pending = NotificationIntents.download(context, ID_1)

        pending.send()
        shadowOf(Looper.getMainLooper()).idle()

        assertEquals("Coming soon", ShadowToast.getTextOfLatestToast())
        assertNotNull(manager.activeNotifications.singleOrNull { it.tag == ID_1 })
    }

    private suspend fun post(id: String, payload: PushPayload) {
        PushNotifier(context, OWN_DEVICE, contentKey).accept(
            PushDTO(
                id = id,
                createdAt = CREATED_AT,
                sourceDeviceId = SOURCE_DEVICE,
                targetDeviceId = null,
                envelope = PushCrypto.encrypt(contentKey, id, payload),
                file = null
            )
        )
    }

    private fun childAction(pushId: String, title: String) = manager.activeNotifications
        .single { it.tag == pushId }
        .notification
        .actions
        .single { it.title.toString() == title }
        .actionIntent

    private companion object {
        const val CREATED_AT = "2026-10-31T12:34:56.789Z"
        const val OWN_DEVICE = "0192e7ce-7c00-7000-8000-000000000001"
        const val SOURCE_DEVICE = "0192e7ce-7c00-7000-8000-000000000002"
        const val ID_1 = "0192e7ce-7c00-7000-8000-000000000101"
        const val ID_2 = "0192e7ce-7c00-7000-8000-000000000102"
        const val ID_3 = "0192e7ce-7c00-7000-8000-000000000103"
    }
}
