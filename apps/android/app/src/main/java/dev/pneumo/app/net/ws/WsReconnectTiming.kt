package dev.pneumo.app.net.ws

import kotlin.random.Random

private const val CONNECTED_RESET_MILLIS = 60_000L
private const val FIRST_RETRY_MILLIS = 1_000L
private const val SECOND_RETRY_MILLIS = 2_000L
private const val THIRD_RETRY_MILLIS = 5_000L
private const val FOURTH_RETRY_MILLIS = 10_000L
private const val FIFTH_RETRY_MILLIS = 30_000L
private const val SIXTH_RETRY_MILLIS = 60_000L
private const val NANOS_PER_MILLISECOND = 1_000_000L
private const val RESTART_DELAY_MIN_MILLIS = 1_000L
private const val RESTART_DELAY_MAX_MILLIS = 3_000L
private val RETRY_DELAY_RANGES = arrayOf(
    0L..FIRST_RETRY_MILLIS,
    0L..SECOND_RETRY_MILLIS,
    0L..THIRD_RETRY_MILLIS,
    0L..FOURTH_RETRY_MILLIS,
    0L..FIFTH_RETRY_MILLIS,
    0L..SIXTH_RETRY_MILLIS
)
private val RESTART_DELAY_RANGE = RESTART_DELAY_MIN_MILLIS..RESTART_DELAY_MAX_MILLIS

class WsReconnectTiming(
    private val monotonicMillis: () -> Long = { System.nanoTime() / NANOS_PER_MILLISECOND },
    private val randomDelayMillis: (LongRange) -> Long = { range ->
        Random.nextLong(range.first, range.last + 1)
    }
) {
    internal fun now(): Long = monotonicMillis()

    internal fun connectedMillis(connectedAt: Long?): Long =
        connectedAt?.let { start -> (now() - start).coerceAtLeast(0) } ?: 0

    internal fun retryIndexAfterConnection(connectedMillis: Long, retryIndex: Int): Int =
        if (connectedMillis >= CONNECTED_RESET_MILLIS) 0 else retryIndex

    internal fun nextRetryIndex(retryIndex: Int): Int = (retryIndex + 1).coerceAtMost(RETRY_DELAY_RANGES.lastIndex)

    internal fun retryDelayMillis(retryIndex: Int): Long = randomDelay(RETRY_DELAY_RANGES[retryIndex])

    internal fun restartDelayMillis(): Long = randomDelay(RESTART_DELAY_RANGE)

    private fun randomDelay(range: LongRange): Long {
        val delay = randomDelayMillis(range)
        require(delay in range) { "Random delay must be within the requested range" }
        return delay
    }
}
