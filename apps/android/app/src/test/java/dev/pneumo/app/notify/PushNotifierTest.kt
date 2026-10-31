package dev.pneumo.app.notify

import android.Manifest
import android.app.Application
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Intent
import android.net.Uri
import android.os.Looper
import android.text.format.Formatter
import androidx.compose.ui.graphics.toArgb
import androidx.test.core.app.ApplicationProvider
import dev.pneumo.app.MainActivity
import dev.pneumo.app.R
import dev.pneumo.app.crypto.Base64Url
import dev.pneumo.app.crypto.PushCrypto
import dev.pneumo.app.protocol.FilePayload
import dev.pneumo.app.protocol.LinkPayload
import dev.pneumo.app.protocol.NotePayload
import dev.pneumo.app.protocol.PayloadFile
import dev.pneumo.app.protocol.PushDTO
import dev.pneumo.app.protocol.PushFile
import dev.pneumo.app.protocol.PushPayload
import dev.pneumo.app.ui.theme.BrandColors
import java.time.Instant
import javax.crypto.SecretKey
import javax.crypto.spec.SecretKeySpec
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PushNotifierTest {
    private val context = ApplicationProvider.getApplicationContext<Application>()
    private val manager = context.getSystemService(NotificationManager::class.java)
    private val contentKey: SecretKey = SecretKeySpec(ByteArray(32) { it.toByte() }, "AES")

    @Before
    fun setUp() {
        manager.cancelAll()
        shadowOf(context).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
    }

    @Test
    fun noteUsesPushChannelBrandPresentationBigTextAndExactCopyBody() = runTest {
        val payload = NotePayload(title = "A title", body = "First line\nSecond line ☃")
        val push = push(ID_1, payload)

        notifier().accept(push)

        val channel = manager.getNotificationChannel(PushNotifier.CHANNEL_ID)
        assertEquals("Pushes", channel.name.toString())
        assertEquals(NotificationManager.IMPORTANCE_HIGH, channel.importance)
        val notification = child(ID_1)
        assertCommon(notification, push)
        assertEquals("A title", notification.extras.getCharSequence(Notification.EXTRA_TITLE).toString())
        assertEquals(payload.body, notification.extras.getCharSequence(Notification.EXTRA_TEXT).toString())
        assertEquals(payload.body, notification.extras.getCharSequence(Notification.EXTRA_BIG_TEXT).toString())
        assertEquals(listOf("Copy"), notification.actions.map { it.title.toString() })
        val copy = shadowOf(notification.actions.single().actionIntent).savedIntent
        assertEquals(CopyReceiver::class.java.name, copy.component?.className)
        assertEquals(payload.body, copy.getStringExtra(NotificationIntents.EXTRA_TEXT))
        val body = shadowOf(notification.contentIntent).savedIntent
        assertEquals(MainActivity::class.java.name, body.component?.className)
        assertEquals(ID_1, body.getStringExtra("pushId"))
    }

    @Test
    fun noteWithoutTitleUsesNoteFallback() = runTest {
        notifier().accept(push(ID_1, NotePayload(body = "Body")))

        assertEquals(
            "Note",
            child(ID_1).extras.getCharSequence(Notification.EXTRA_TITLE).toString()
        )
    }

    @Test
    fun linkUsesHostFallbackExactUrlAndOpenThenCopyActions() = runTest {
        val payload = LinkPayload(body = "Caption is not notification text", url = "https://docs.example.test/a?q=1")
        val push = push(ID_2, payload)

        notifier().accept(push)

        val notification = child(ID_2)
        assertCommon(notification, push)
        assertEquals("docs.example.test", notification.extras.getCharSequence(Notification.EXTRA_TITLE).toString())
        assertEquals(payload.url, notification.extras.getCharSequence(Notification.EXTRA_TEXT).toString())
        assertNull(notification.extras.getCharSequence(Notification.EXTRA_BIG_TEXT))
        assertEquals(listOf("Open", "Copy"), notification.actions.map { it.title.toString() })
        val open = shadowOf(notification.actions[0].actionIntent).savedIntent
        assertEquals(Intent.ACTION_VIEW, open.action)
        assertEquals(OpenActivity::class.java.name, open.component?.className)
        assertEquals(Uri.parse(payload.url), open.data)
        val copy = shadowOf(notification.actions[1].actionIntent).savedIntent
        assertEquals(payload.url, copy.getStringExtra(NotificationIntents.EXTRA_TEXT))
    }

    @Test
    fun nonHttpUrlsDoNotProduceAnOpenAction() {
        for (url in listOf("javascript:alert(1)", "file:///sdcard/private.txt", "content://private/item", "https://")) {
            assertNull(NotificationIntents.openUrl(context, ID_1, url))
        }
    }

    @Test
    fun fileUsesFilenameFormattedSizeCaptionAndDownloadAction() = runTest {
        val payload = FilePayload(
            title = "Ignored payload title",
            body = "Release build",
            file = PayloadFile(
                "pneumo.apk",
                "application/vnd.android.package-archive",
                1_536,
                Base64Url.encode(ByteArray(32))
            )
        )
        val push = push(ID_3, payload, file = PushFile(FILE_ID, 1_552))

        notifier().accept(push)

        val notification = child(ID_3)
        assertCommon(notification, push)
        assertEquals("pneumo.apk", notification.extras.getCharSequence(Notification.EXTRA_TITLE).toString())
        assertEquals(
            "${Formatter.formatShortFileSize(context, payload.file.size)} • Release build",
            notification.extras.getCharSequence(Notification.EXTRA_TEXT).toString()
        )
        assertNull(notification.extras.getCharSequence(Notification.EXTRA_BIG_TEXT))
        assertEquals(listOf("Download"), notification.actions.map { it.title.toString() })
        val download = shadowOf(notification.actions.single().actionIntent).savedIntent
        assertEquals(DownloadRequestedReceiver::class.java.name, download.component?.className)
        assertEquals(ID_3, download.getStringExtra(NotificationIntents.EXTRA_PUSH_ID))
    }

    @Test
    fun onlyPushesFromAnotherDeviceTargetedToThisDeviceOrAllAreEligible() = runTest {
        val notifier = notifier()

        notifier.accept(push(ID_1, NotePayload(body = "Own"), source = OWN_DEVICE))
        notifier.accept(push(ID_2, NotePayload(body = "Other target"), target = OTHER_TARGET))
        notifier.accept(push(ID_3, NotePayload(body = "Broadcast")))
        notifier.accept(push(ID_4, NotePayload(body = "Direct"), target = OWN_DEVICE))

        assertEquals(setOf(ID_3, ID_4), childTags())
    }

    @Test
    fun deniedNotificationPermissionSkipsBeforeDecrypting() = runTest {
        shadowOf(context).denyPermissions(Manifest.permission.POST_NOTIFICATIONS)
        val wrongKey = SecretKeySpec(ByteArray(32) { (it + 1).toByte() }, "AES")
        val payload = NotePayload(body = "Private")
        val encryptedWithWrongKey = push(ID_1, payload).copy(
            envelope = PushCrypto.encrypt(wrongKey, ID_1, payload)
        )

        notifier().accept(encryptedWithWrongKey)

        assertTrue(manager.activeNotifications.isEmpty())
    }

    @Test
    fun summaryAppearsAtThreePushChildrenIgnoresOtherChannelsAndReconcilesCancelAndDismiss() = runTest {
        val connectionChannel = NotificationChannel("connection-test", "Connection", NotificationManager.IMPORTANCE_MIN)
        manager.createNotificationChannel(connectionChannel)
        manager.notify(
            "connection",
            1,
            Notification.Builder(context, connectionChannel.id)
                .setSmallIcon(R.drawable.ic_notification)
                .setGroup(PushNotificationGroup.GROUP_KEY)
                .build()
        )
        val notifier = notifier()
        notifier.accept(push(ID_1, NotePayload(body = "One")))
        notifier.accept(push(ID_2, NotePayload(body = "Two")))
        assertNull(summary())

        notifier.accept(push(ID_3, NotePayload(body = "Three")))
        assertEquals("3 new pushes", summary()?.extras?.getCharSequence(Notification.EXTRA_TEXT).toString())

        notifier.cancel(ID_1)
        assertEquals(setOf(ID_2, ID_3), childTags())
        assertNull(summary())

        notifier.accept(push(ID_4, NotePayload(body = "Four")))
        assertTrue(summary() != null)
        child(ID_2).deleteIntent.send()
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals(setOf(ID_3, ID_4), childTags())
        assertNull(summary())
    }

    @Test
    fun pendingIntentIdentityIsIsolatedEvenWhenPushStringHashesCollide() = runTest {
        assertNotEquals(COLLIDING_ID_1, COLLIDING_ID_2)
        assertEquals(COLLIDING_ID_1.hashCode(), COLLIDING_ID_2.hashCode())
        val notifier = notifier()
        notifier.accept(push(COLLIDING_ID_1, NotePayload(body = "First body")))
        notifier.accept(push(COLLIDING_ID_2, NotePayload(body = "Second body")))

        val first = child(COLLIDING_ID_1)
        val second = child(COLLIDING_ID_2)
        val firstCopy = first.actions.single().actionIntent
        val secondCopy = second.actions.single().actionIntent
        assertNotEquals(firstCopy, secondCopy)
        assertNotEquals(
            shadowOf(firstCopy).savedIntent.data,
            shadowOf(secondCopy).savedIntent.data
        )
        assertNotEquals(first.contentIntent, second.contentIntent)
        assertEquals("First body", shadowOf(firstCopy).savedIntent.getStringExtra(NotificationIntents.EXTRA_TEXT))
        assertEquals("Second body", shadowOf(secondCopy).savedIntent.getStringExtra(NotificationIntents.EXTRA_TEXT))
        val sharedUrl = "https://example.test/shared"
        val firstOpen = requireNotNull(NotificationIntents.openUrl(context, COLLIDING_ID_1, sharedUrl))
        val secondOpen = requireNotNull(NotificationIntents.openUrl(context, COLLIDING_ID_2, sharedUrl))
        assertNotEquals(firstOpen, secondOpen)
        assertEquals(Uri.parse(sharedUrl), shadowOf(firstOpen).savedIntent.data)
        assertEquals(Uri.parse(sharedUrl), shadowOf(secondOpen).savedIntent.data)
        assertNotEquals(
            shadowOf(firstOpen).savedIntent.categories,
            shadowOf(secondOpen).savedIntent.categories
        )
    }

    private fun notifier() = PushNotifier(context, OWN_DEVICE, contentKey)

    private fun push(
        id: String,
        payload: PushPayload,
        source: String = SOURCE_DEVICE,
        target: String? = null,
        file: PushFile? = null
    ) = PushDTO(
        id = id,
        createdAt = CREATED_AT,
        sourceDeviceId = source,
        targetDeviceId = target,
        envelope = PushCrypto.encrypt(contentKey, id, payload),
        file = file
    )

    private fun child(pushId: String): Notification = manager.activeNotifications
        .single { it.tag == pushId }
        .notification

    private fun childTags(): Set<String> = manager.activeNotifications
        .filter { it.notification.channelId == PushNotifier.CHANNEL_ID && it.tag != PushNotificationGroup.SUMMARY_TAG }
        .mapNotNull { it.tag }
        .toSet()

    private fun summary(): Notification? = manager.activeNotifications
        .singleOrNull { it.tag == PushNotificationGroup.SUMMARY_TAG }
        ?.notification

    private fun assertCommon(notification: Notification, push: PushDTO) {
        assertEquals(PushNotifier.CHANNEL_ID, notification.channelId)
        assertEquals(R.drawable.ic_notification, notification.smallIcon.resId)
        assertEquals(BrandColors.Light.Accent.toArgb(), notification.color)
        assertEquals(Instant.parse(push.createdAt).toEpochMilli(), notification.`when`)
        assertEquals(push.id.hashCode(), manager.activeNotifications.single { it.tag == push.id }.id)
        assertEquals(PushNotificationGroup.GROUP_KEY, notification.group)
        assertTrue(notification.flags and Notification.FLAG_AUTO_CANCEL != 0)
        assertFalse(notification.flags and Notification.FLAG_GROUP_SUMMARY != 0)
    }

    private companion object {
        const val CREATED_AT = "2026-10-31T12:34:56.789Z"
        const val OWN_DEVICE = "0192e7ce-7c00-7000-8000-000000000001"
        const val SOURCE_DEVICE = "0192e7ce-7c00-7000-8000-000000000002"
        const val OTHER_TARGET = "0192e7ce-7c00-7000-8000-000000000003"
        const val ID_1 = "0192e7ce-7c00-7000-8000-000000000101"
        const val ID_2 = "0192e7ce-7c00-7000-8000-000000000102"
        const val ID_3 = "0192e7ce-7c00-7000-8000-000000000103"
        const val ID_4 = "0192e7ce-7c00-7000-8000-000000000104"
        const val FILE_ID = "0192e7ce-7c00-7000-8000-000000000201"
        const val COLLIDING_ID_1 = "0192e7ce-7c00-7000-8000-c5117ab52f60"
        const val COLLIDING_ID_2 = "0192e7ce-7c00-7000-8000-d2419fc81abb"
    }
}
