package dev.pneumo.app.net.ws

import dev.pneumo.app.protocol.ClientFrame
import dev.pneumo.app.protocol.PingFrame
import dev.pneumo.app.protocol.PongFrame
import dev.pneumo.app.protocol.ProtocolJson
import dev.pneumo.app.protocol.ReadyFrame
import dev.pneumo.app.protocol.ServerFrame
import dev.pneumo.app.protocol.WS_CLOSE_PROTOCOL_ERROR
import dev.pneumo.app.protocol.WS_CLOSE_RESTARTING
import dev.pneumo.app.protocol.WS_CLOSE_UNAUTHORIZED
import dev.pneumo.app.protocol.WS_WATCHDOG_MILLIS
import java.io.IOException
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.isActive
import kotlinx.coroutines.selects.select
import kotlinx.coroutines.supervisorScope
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

internal class WsConnectionSession(
    private val transport: WsTransport,
    private val network: NetworkMonitor,
    private val session: WsSessionConfig,
    private val timing: WsReconnectTiming,
    private val updateState: (ConnectionState) -> Unit
) {
    suspend fun run(applicationFrames: Channel<ServerFrame>, processor: Deferred<IOException?>): Outcome =
        supervisorScope {
            val connection = transport.open()
            val networkLost = async { network.available.first { available -> !available } }
            val progress = Progress()

            try {
                while (currentCoroutineContext().isActive) {
                    when (val result = awaitResult(connection, processor, networkLost)) {
                        is WaitResult.Socket -> {
                            val outcome = handleSocketEvent(
                                connection,
                                result.event,
                                applicationFrames,
                                progress
                            )
                            if (outcome != null) {
                                return@supervisorScope outcome
                            }
                        }

                        is WaitResult.ProcessorStopped ->
                            return@supervisorScope Outcome.ApplicationFailed(
                                result.failure,
                                timing.connectedMillis(progress.connectedAt)
                            )

                        WaitResult.NetworkLost -> {
                            updateState(ConnectionState.Offline)
                            return@supervisorScope Outcome.NetworkLost(
                                timing.connectedMillis(progress.connectedAt)
                            )
                        }

                        WaitResult.WatchdogExpired -> return@supervisorScope disconnected(progress)
                    }
                }
                disconnected(progress)
            } finally {
                connection.cancel()
                networkLost.cancel()
                withContext(NonCancellable) {
                    networkLost.join()
                }
            }
        }

    private suspend fun awaitResult(
        connection: WsConnection,
        processor: Deferred<IOException?>,
        networkLost: Deferred<Boolean>
    ): WaitResult = withTimeoutOrNull(WS_WATCHDOG_MILLIS) {
        select {
            connection.events.onReceiveCatching { received ->
                val event = received.getOrNull()
                    ?: WsEvent.Failure(IOException("WebSocket event stream ended"))
                WaitResult.Socket(event)
            }
            processor.onAwait { failure ->
                WaitResult.ProcessorStopped(
                    failure ?: IOException("WebSocket frame processor ended")
                )
            }
            networkLost.onAwait { WaitResult.NetworkLost }
        }
    } ?: WaitResult.WatchdogExpired

    private suspend fun handleSocketEvent(
        connection: WsConnection,
        event: WsEvent,
        applicationFrames: Channel<ServerFrame>,
        progress: Progress
    ): Outcome? = when (event) {
        WsEvent.Opened -> handleOpened(connection, progress)

        is WsEvent.Text ->
            handleTextFrame(connection, event.value, applicationFrames, progress)

        is WsEvent.Closed -> when (event.code) {
            WS_CLOSE_UNAUTHORIZED -> Outcome.Unauthorized

            WS_CLOSE_RESTARTING ->
                Outcome.Restarting(timing.connectedMillis(progress.connectedAt))

            else -> disconnected(progress)
        }

        is WsEvent.Failure -> disconnected(progress)
    }

    private suspend fun handleOpened(connection: WsConnection, progress: Progress): Outcome? =
        if (progress.opened || !sendHello(connection)) {
            protocolError(connection, progress)
        } else {
            progress.opened = true
            null
        }

    private fun handleTextFrame(
        connection: WsConnection,
        value: String,
        applicationFrames: Channel<ServerFrame>,
        progress: Progress
    ): Outcome? {
        if (!progress.opened) return protocolError(connection, progress)
        val frame = decodeFrame(value)
        return if (frame == null) {
            protocolError(connection, progress)
        } else {
            handleDecodedFrame(connection, frame, applicationFrames, progress)
        }
    }

    private fun handleDecodedFrame(
        connection: WsConnection,
        frame: ServerFrame,
        applicationFrames: Channel<ServerFrame>,
        progress: Progress
    ): Outcome? {
        if (frame is PingFrame) {
            val pong = PongFrame(type = PONG_TYPE)
            val text = ProtocolJson.encodeToString(ClientFrame.serializer(), pong)
            if (!connection.send(text)) return disconnected(progress)
        }
        if (frame is ReadyFrame) {
            if (progress.connectedAt == null) {
                progress.connectedAt = timing.now()
            }
            updateState(ConnectionState.Connected)
        }
        return if (applicationFrames.trySend(frame).isSuccess) null else disconnected(progress)
    }

    private fun protocolError(connection: WsConnection, progress: Progress): Outcome.Disconnected {
        connection.close(WS_CLOSE_PROTOCOL_ERROR, PROTOCOL_ERROR_REASON)
        return disconnected(progress)
    }

    private fun disconnected(progress: Progress): Outcome.Disconnected {
        val state =
            if (network.available.value) ConnectionState.Reconnecting else ConnectionState.Offline
        updateState(state)
        return Outcome.Disconnected(timing.connectedMillis(progress.connectedAt))
    }

    private suspend fun sendHello(connection: WsConnection): Boolean {
        val text = ProtocolJson.encodeToString(ClientFrame.serializer(), session.helloFrame())
        return connection.send(text)
    }

    private fun decodeFrame(value: String): ServerFrame? = try {
        ProtocolJson.decodeFromString(ServerFrame.serializer(), value)
    } catch (ignored: IllegalArgumentException) {
        null
    }

    private class Progress(var opened: Boolean = false, var connectedAt: Long? = null)

    sealed interface Outcome {
        data class Disconnected(val connectedMillis: Long) : Outcome

        data class ApplicationFailed(val failure: IOException, val connectedMillis: Long) : Outcome

        data class NetworkLost(val connectedMillis: Long) : Outcome

        data class Restarting(val connectedMillis: Long) : Outcome

        data object Unauthorized : Outcome
    }

    private sealed interface WaitResult {
        data class Socket(val event: WsEvent) : WaitResult

        data class ProcessorStopped(val failure: IOException) : WaitResult

        data object NetworkLost : WaitResult

        data object WatchdogExpired : WaitResult
    }

    private companion object {
        const val PONG_TYPE = "pong"
        const val PROTOCOL_ERROR_REASON = "Protocol error"
    }
}
