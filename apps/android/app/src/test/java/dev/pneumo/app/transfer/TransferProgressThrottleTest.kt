package dev.pneumo.app.transfer

import android.Manifest
import android.app.Application
import android.app.Notification
import android.app.NotificationManager
import androidx.test.core.app.ApplicationProvider
import java.time.Duration
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowSystemClock

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class TransferProgressThrottleTest {
    @Test
    fun rapidWholePercentChangesProduceAtMostTwoProgressPostsPerSecond() {
        var elapsed = 0L
        val throttle = TransferProgressThrottle { elapsed }
        val posted = mutableListOf<Pair<Long, Int>>()

        for (percent in 1..100) {
            elapsed = percent * 10L
            if (throttle.shouldNotify(percent)) posted += elapsed to percent
        }

        assertEquals(listOf(500L to 50, 1_000L to 100), posted)
    }

    @Test
    fun suppressedAndRepeatedPercentagesDoNotRestartThePostingInterval() {
        var elapsed = 0L
        val throttle = TransferProgressThrottle { elapsed }

        elapsed = 499L
        assertFalse(throttle.shouldNotify(40))
        elapsed = 500L
        assertTrue(throttle.shouldNotify(40))
        elapsed = 999L
        assertFalse(throttle.shouldNotify(40))
        elapsed = 1_000L
        assertFalse(throttle.shouldNotify(40))
        assertTrue(throttle.shouldNotify(41))
    }

    @Test
    fun uploadProgressKeepsTheLastVisiblePercentageUntilTheIntervalExpires() {
        val context = ApplicationProvider.getApplicationContext<Application>()
        shadowOf(context).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
        val manager = context.getSystemService(NotificationManager::class.java)
        val foreground = UploadForeground(context, 123)
        val initial = foreground.info(0)
        manager.notify(initial.notificationId, initial.notification)

        (1..99).forEach(foreground::update)
        assertEquals(0, manager.activeNotifications.single().notification.extras.getInt(Notification.EXTRA_PROGRESS))

        ShadowSystemClock.advanceBy(Duration.ofMillis(500))
        foreground.update(50)
        assertEquals(50, manager.activeNotifications.single().notification.extras.getInt(Notification.EXTRA_PROGRESS))

        ShadowSystemClock.advanceBy(Duration.ofMillis(499))
        foreground.update(75)
        assertEquals(50, manager.activeNotifications.single().notification.extras.getInt(Notification.EXTRA_PROGRESS))

        ShadowSystemClock.advanceBy(Duration.ofMillis(1))
        foreground.update(75)
        assertEquals(75, manager.activeNotifications.single().notification.extras.getInt(Notification.EXTRA_PROGRESS))
    }
}
