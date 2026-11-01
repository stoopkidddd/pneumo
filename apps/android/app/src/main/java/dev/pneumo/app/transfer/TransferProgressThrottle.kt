package dev.pneumo.app.transfer

import android.os.SystemClock

internal class TransferProgressThrottle(private val gate: Gate = sharedGate) {
    private var lastPercent = 0

    fun shouldNotify(percent: Int): Boolean {
        if (percent == lastPercent || !gate.tryAcquire()) return false
        lastPercent = percent
        return true
    }

    internal class Gate(private val elapsedRealtime: () -> Long = SystemClock::elapsedRealtime) {
        private var lastPostedAt = elapsedRealtime()

        @Synchronized
        fun tryAcquire(): Boolean {
            val now = elapsedRealtime()
            if (now - lastPostedAt < INTERVAL_MS) return false
            lastPostedAt = now
            return true
        }
    }

    private companion object {
        // WorkManager enqueues twice per download foreground update. Share this budget across transfers.
        const val INTERVAL_MS = 1_000L
        val sharedGate = Gate()
    }
}
