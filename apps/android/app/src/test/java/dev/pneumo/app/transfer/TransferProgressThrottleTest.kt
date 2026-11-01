package dev.pneumo.app.transfer

import android.Manifest
import android.app.Application
import android.app.Notification
import android.app.NotificationManager
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class TransferProgressThrottleTest {
    @Test
    fun rapidWholePercentChangesProduceAtMostOneProgressPostPerSecond() {
        var elapsed = 0L
        val throttle = TransferProgressThrottle(TransferProgressThrottle.Gate { elapsed })
        val posted = mutableListOf<Pair<Long, Int>>()

        for (percent in 1..100) {
            elapsed = percent * 10L
            if (throttle.shouldNotify(percent)) posted += elapsed to percent
        }

        assertEquals(listOf(1_000L to 100), posted)
    }

    @Test
    fun suppressedAndRepeatedPercentagesDoNotRestartThePostingInterval() {
        var elapsed = 0L
        val throttle = TransferProgressThrottle(TransferProgressThrottle.Gate { elapsed })

        elapsed = 999L
        assertFalse(throttle.shouldNotify(40))
        elapsed = 1_000L
        assertTrue(throttle.shouldNotify(40))
        elapsed = 1_999L
        assertFalse(throttle.shouldNotify(40))
        elapsed = 2_000L
        assertFalse(throttle.shouldNotify(40))
        assertTrue(throttle.shouldNotify(41))
    }

    @Test
    fun twoTransfersShareOneProgressPostPerIntervalCombined() {
        var elapsed = 0L
        val gate = TransferProgressThrottle.Gate { elapsed }
        val first = TransferProgressThrottle(gate)
        val second = TransferProgressThrottle(gate)
        val posted = mutableListOf<Pair<Long, String>>()

        for (percent in 1..100) {
            elapsed = percent * 100L
            val attempts = if (percent % 20 == 10) {
                listOf("second" to second, "first" to first)
            } else {
                listOf("first" to first, "second" to second)
            }
            for ((name, throttle) in attempts) {
                if (throttle.shouldNotify(percent)) posted += elapsed to name
            }
        }

        assertEquals(
            (1..10).map { secondIndex ->
                secondIndex * 1_000L to if (secondIndex % 2 == 0) "first" else "second"
            },
            posted
        )
    }

    @Test
    fun aRejectedTransferCanPostTheSamePercentageInTheNextInterval() {
        var elapsed = 0L
        val gate = TransferProgressThrottle.Gate { elapsed }
        val first = TransferProgressThrottle(gate)
        val second = TransferProgressThrottle(gate)

        elapsed = 1_000L
        assertTrue(first.shouldNotify(20))
        assertFalse(second.shouldNotify(20))
        elapsed = 2_000L
        assertFalse(first.shouldNotify(20))
        assertTrue(second.shouldNotify(20))
    }

    @Test
    fun uploadProgressKeepsTheLastVisiblePercentageUntilTheIntervalExpires() {
        val context = ApplicationProvider.getApplicationContext<Application>()
        shadowOf(context).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
        val manager = context.getSystemService(NotificationManager::class.java)
        var elapsed = 0L
        val throttle = TransferProgressThrottle(TransferProgressThrottle.Gate { elapsed })
        val foreground = UploadForeground(context, 123, throttle)
        val initial = foreground.info(0)
        manager.notify(initial.notificationId, initial.notification)

        (1..99).forEach(foreground::update)
        assertEquals(0, manager.activeNotifications.single().notification.extras.getInt(Notification.EXTRA_PROGRESS))

        elapsed = 1_000L
        foreground.update(50)
        assertEquals(50, manager.activeNotifications.single().notification.extras.getInt(Notification.EXTRA_PROGRESS))

        elapsed = 1_999L
        foreground.update(75)
        assertEquals(50, manager.activeNotifications.single().notification.extras.getInt(Notification.EXTRA_PROGRESS))

        elapsed = 2_000L
        foreground.update(75)
        assertEquals(75, manager.activeNotifications.single().notification.extras.getInt(Notification.EXTRA_PROGRESS))
    }
}
