package dev.pneumo.app.net.ws

import dev.pneumo.app.net.ApiError
import dev.pneumo.app.protocol.ServerFrame
import java.io.IOException
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.isActive
import kotlinx.coroutines.selects.select
import kotlinx.coroutines.supervisorScope
import kotlinx.coroutines.withContext

private const val FRAME_BUFFER_CAPACITY = 256

enum class ConnectionState {
    Connected,
    Reconnecting,
    Offline
}

class WsClient(
    private val transport: WsTransport,
    private val network: NetworkMonitor,
    private val session: WsSessionConfig,
    private val onFrame: suspend (ServerFrame) -> Unit,
    private val onUnauthorized: suspend () -> Unit,
    private val timing: WsReconnectTiming = WsReconnectTiming()
) {
    private val mutableState =
        MutableStateFlow(if (network.available.value) ConnectionState.Reconnecting else ConnectionState.Offline)
    private val running = AtomicBoolean(false)
    private val terminalUnauthorized = AtomicBoolean(false)
    private val connectionSession = WsConnectionSession(
        transport = transport,
        network = network,
        session = session,
        timing = timing,
        updateState = { state -> mutableState.value = state }
    )

    val state: StateFlow<ConnectionState> = mutableState.asStateFlow()

    suspend fun run() {
        if (terminalUnauthorized.get()) {
            mutableState.value = ConnectionState.Offline
            return
        }
        check(running.compareAndSet(false, true)) { "WsClient is already running" }

        try {
            runLoop()
        } finally {
            mutableState.value = ConnectionState.Offline
            running.set(false)
        }
    }

    private suspend fun runLoop(): Unit = supervisorScope {
        var retryIndex = 0
        var pipeline = createPipeline()
        try {
            while (currentCoroutineContext().isActive && !terminalUnauthorized.get()) {
                awaitNetworkIfUnavailable()
                mutableState.value = ConnectionState.Reconnecting

                val outcome = try {
                    connectionSession.run(pipeline.frames, pipeline.processor)
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (ignored: IOException) {
                    WsConnectionSession.Outcome.Disconnected(connectedMillis = 0)
                }

                when (outcome) {
                    WsConnectionSession.Outcome.Unauthorized -> terminateUnauthorized()

                    is WsConnectionSession.Outcome.NetworkLost -> {
                        retryIndex = timing.retryIndexAfterConnection(outcome.connectedMillis, retryIndex)
                    }

                    is WsConnectionSession.Outcome.Restarting -> {
                        retryIndex = timing.retryIndexAfterConnection(outcome.connectedMillis, retryIndex)
                        awaitRetry(timing.restartDelayMillis())
                    }

                    is WsConnectionSession.Outcome.ApplicationFailed -> {
                        stopPipeline(pipeline)
                        if (outcome.failure is ApiError.Unauthorized) {
                            terminateUnauthorized()
                        } else {
                            pipeline = createPipeline()
                            retryIndex = retryAfterDisconnect(outcome.connectedMillis, retryIndex)
                        }
                    }

                    is WsConnectionSession.Outcome.Disconnected -> {
                        retryIndex = retryAfterDisconnect(outcome.connectedMillis, retryIndex)
                    }
                }
            }
        } finally {
            stopPipeline(pipeline)
        }
    }

    private suspend fun retryAfterDisconnect(connectedMillis: Long, retryIndex: Int): Int {
        val currentIndex = timing.retryIndexAfterConnection(connectedMillis, retryIndex)
        awaitRetry(timing.retryDelayMillis(currentIndex))
        return timing.nextRetryIndex(currentIndex)
    }

    private fun CoroutineScope.createPipeline(): ApplicationPipeline {
        val frames = Channel<ServerFrame>(FRAME_BUFFER_CAPACITY)
        val processor = async {
            try {
                for (frame in frames) {
                    onFrame(frame)
                }
                null
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: IOException) {
                failure
            }
        }
        return ApplicationPipeline(frames, processor)
    }

    private suspend fun stopPipeline(pipeline: ApplicationPipeline) {
        pipeline.frames.cancel()
        pipeline.processor.cancel()
        withContext(NonCancellable) {
            pipeline.processor.join()
        }
    }

    private suspend fun terminateUnauthorized() {
        mutableState.value = ConnectionState.Offline
        if (terminalUnauthorized.compareAndSet(false, true)) {
            onUnauthorized()
        }
    }

    private suspend fun awaitNetworkIfUnavailable() {
        if (!network.available.value) {
            mutableState.value = ConnectionState.Offline
            network.available.first { available -> available }
        }
    }

    private suspend fun awaitRetry(delayMillis: Long) = coroutineScope {
        if (!network.available.value) {
            awaitNetworkIfUnavailable()
            return@coroutineScope
        }
        mutableState.value = ConnectionState.Reconnecting
        if (delayMillis == 0L) {
            return@coroutineScope
        }

        val timer = async { delay(delayMillis) }
        val networkLost = async { network.available.first { available -> !available } }
        val wentOffline = try {
            select<Boolean> {
                timer.onAwait { false }
                networkLost.onAwait { true }
            }
        } finally {
            timer.cancel()
            networkLost.cancel()
        }
        if (wentOffline) {
            awaitNetworkIfUnavailable()
        }
    }

    private data class ApplicationPipeline(val frames: Channel<ServerFrame>, val processor: Deferred<IOException?>)
}
