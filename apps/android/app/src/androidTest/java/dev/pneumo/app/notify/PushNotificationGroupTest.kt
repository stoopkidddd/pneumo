package dev.pneumo.app.notify

import android.Manifest
import android.app.NotificationManager
import android.content.pm.PackageManager
import android.os.Build
import android.os.SystemClock
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.pneumo.app.crypto.PushCrypto
import dev.pneumo.app.protocol.NotePayload
import dev.pneumo.app.protocol.PushDTO
import javax.crypto.spec.SecretKeySpec
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class PushNotificationGroupTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private val manager = context.getSystemService(NotificationManager::class.java)
    private val contentKey = SecretKeySpec(ByteArray(32) { 7 }, "AES")
    private lateinit var notifier: PushNotifier

    @Before
    fun setUp() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            instrumentation.uiAutomation.grantRuntimePermission(
                context.packageName,
                Manifest.permission.POST_NOTIFICATIONS
            )
        }
        notifier = PushNotifier(context, OWN_DEVICE, contentKey)
        clearPushes()
    }

    @After
    fun tearDown() {
        clearPushes()
    }

    @Test
    fun copyingOneOfThreeBurstPushesPreservesTheOtherTwo() = runBlocking {
        postBurst()
        awaitTags(IDS.toSet() + PushNotificationGroup.SUMMARY_TAG)
        val notification = manager.activeNotifications.single { it.tag == IDS.first() }.notification

        notification.actions.single { it.title.toString() == "Copy" }.actionIntent.send()

        awaitTags(IDS.drop(1).toSet() + PushNotificationGroup.SUMMARY_TAG)
        notifier.cancel(IDS[1])
        awaitTags(setOf(IDS[2], PushNotificationGroup.SUMMARY_TAG))
        notifier.cancel(IDS[2])
        awaitTags(emptySet())
    }

    @Test
    fun dismissingOneOfThreeBurstPushesPreservesTheOtherTwo() = runBlocking {
        postBurst()
        awaitTags(IDS.toSet() + PushNotificationGroup.SUMMARY_TAG)
        val dismissed = manager.activeNotifications.single { it.tag == IDS.first() }.notification

        // SystemUI removes the child before delivering its delete PendingIntent.
        manager.cancel(IDS.first(), IDS.first().hashCode())
        awaitTags(IDS.drop(1).toSet() + PushNotificationGroup.SUMMARY_TAG)
        dismissed.deleteIntent.send()

        awaitTags(IDS.drop(1).toSet() + PushNotificationGroup.SUMMARY_TAG)
    }

    private suspend fun postBurst() {
        for (id in IDS) {
            notifier.accept(
                PushDTO(
                    id = id,
                    createdAt = "2026-10-31T12:34:56.789Z",
                    sourceDeviceId = SOURCE_DEVICE,
                    targetDeviceId = null,
                    envelope = PushCrypto.encrypt(contentKey, id, NotePayload(body = "Group regression")),
                    file = null
                )
            )
        }
    }

    private fun clearPushes() {
        runBlocking {
            for (id in IDS) notifier.cancel(id)
        }
        awaitTags(emptySet())
    }

    private fun awaitTags(expected: Set<String>) {
        val deadline = SystemClock.elapsedRealtime() + TIMEOUT_MILLIS
        var matchedSince: Long? = null
        var actual = emptySet<String>()
        while (SystemClock.elapsedRealtime() < deadline) {
            actual = manager.activeNotifications
                .filter { it.notification.channelId == PushNotifier.CHANNEL_ID }
                .mapNotNull { it.tag }
                .toSet()
            val now = SystemClock.elapsedRealtime()
            if (actual == expected) {
                val since = matchedSince ?: now.also { matchedSince = it }
                if (now - since >= STABLE_MILLIS) return
            } else {
                matchedSince = null
            }
            SystemClock.sleep(POLL_MILLIS)
        }
        fail("Notification tags did not stay stable: expected=$expected, actual=$actual")
    }

    private companion object {
        const val OWN_DEVICE = "0192e7ce-7c00-7000-8000-000000000001"
        const val SOURCE_DEVICE = "0192e7ce-7c00-7000-8000-000000000002"
        const val TIMEOUT_MILLIS = 10_000L
        const val STABLE_MILLIS = 500L
        const val POLL_MILLIS = 25L
        val IDS = listOf(
            "0192e7ce-7c00-7000-8000-000000000101",
            "0192e7ce-7c00-7000-8000-000000000102",
            "0192e7ce-7c00-7000-8000-000000000103"
        )
    }
}
