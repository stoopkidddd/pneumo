package dev.pneumo.app.transfer

import android.os.SystemClock

internal class TransferProgressThrottle(private val elapsedRealtime: () -> Long = SystemClock::elapsedRealtime) {
    private var lastPercent = 0
    private var lastPostedAt = elapsedRealtime()

    fun shouldNotify(percent: Int): Boolean {
        if (percent != lastPercent) {
            val now = elapsedRealtime()
            if (now - lastPostedAt >= INTERVAL_MS) {
                lastPercent = percent
                lastPostedAt = now
                return true
            }
        }
        return false
    }

    private companion object {
        // Leave room for initial/terminal notifications and their group-summary updates.
        const val INTERVAL_MS = 500L
    }
}
