package dev.pneumo.app.net.ws

import app.cash.turbine.test
import dev.pneumo.app.net.ApiError
import dev.pneumo.app.protocol.ClientFrame
import dev.pneumo.app.protocol.HelloFrame
import dev.pneumo.app.protocol.PingFrame
import dev.pneumo.app.protocol.Platform
import dev.pneumo.app.protocol.PongFrame
import dev.pneumo.app.protocol.ProtocolJson
import dev.pneumo.app.protocol.ReadyFrame
import dev.pneumo.app.protocol.ServerFrame
import dev.pneumo.app.protocol.WS_CLOSE_RESTARTING
import dev.pneumo.app.protocol.WS_CLOSE_UNAUTHORIZED
import dev.pneumo.app.protocol.WS_WATCHDOG_MILLIS
import java.io.IOException
import java.util.Base64
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.ReceiveChannel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class WsClientTest {
    @Test
    fun sessionConfigRedactsCredentials() {
        val description = WsSessionConfig(
            token = TOKEN,
            version = VERSION,
            since = { PUSH_ID }
        ).toString()

        assertFalse(description.contains(TOKEN))
        assertFalse(description.contains(PUSH_ID))
    }

    @Test
    fun helloUsesCurrentCursorOnEveryConnection() = runTest {
        val fixture = Fixture()
        val cursors = ArrayDeque(listOf(PUSH_ID, NEXT_PUSH_ID))
        val client = fixture.client(since = { cursors.removeFirst() })
        backgroundScope.launch { client.run() }
        runCurrent()

        val first = fixture.transport.connections.single()
        first.emit(WsEvent.Opened)
        runCurrent()
        assertHello(first.sent.single(), PUSH_ID)

        first.emit(WsEvent.Failure(IOException("connection ended")))
        runCurrent()
        advanceTimeBy(1_000)
        runCurrent()
        val second = fixture.transport.connections.last()
        second.emit(WsEvent.Opened)
        runCurrent()
        assertHello(second.sent.single(), NEXT_PUSH_ID)
    }

    @Test
    fun readyConnectsAndSlowApplicationDoesNotDelayPongOrFrameOrder() = runTest {
        val fixture = Fixture()
        val releaseReady = CompletableDeferred<Unit>()
        val applied = mutableListOf<ServerFrame>()
        val client = fixture.client(
            onFrame = { frame ->
                applied += frame
                if (frame is ReadyFrame) {
                    releaseReady.await()
                }
            }
        )

        client.state.test {
            assertEquals(ConnectionState.Reconnecting, awaitItem())
            backgroundScope.launch { client.run() }
            runCurrent()
            val connection = fixture.transport.connections.single()
            connection.emit(WsEvent.Opened)
            connection.emit(WsEvent.Text(serverText(readyFrame())))
            runCurrent()
            assertEquals(ConnectionState.Connected, awaitItem())

            connection.emit(WsEvent.Text(serverText(PingFrame(type = "ping"))))
            runCurrent()
            val pong = ProtocolJson.decodeFromString(ClientFrame.serializer(), connection.sent.last())
            assertTrue(pong is PongFrame)
            assertEquals(listOf(ReadyFrame::class), applied.map { frame -> frame::class })

            releaseReady.complete(Unit)
            runCurrent()
            assertEquals(listOf(ReadyFrame::class, PingFrame::class), applied.map { frame -> frame::class })
            cancelAndIgnoreRemainingEvents()
        }
    }

    @Test
    fun everyFrameResetsWatchdogBeforeItReconnects() = runTest {
        val fixture = Fixture()
        val client = fixture.client()
        backgroundScope.launch { client.run() }
        runCurrent()
        val connection = fixture.transport.connections.single()
        connection.emit(WsEvent.Opened)
        runCurrent()

        advanceTimeBy(100_000)
        connection.emit(WsEvent.Text(serverText(PingFrame(type = "ping"))))
        runCurrent()
        advanceTimeBy(WS_WATCHDOG_MILLIS - 1)
        runCurrent()
        assertFalse(connection.cancelled)

        advanceTimeBy(1)
        runCurrent()
        assertTrue(connection.cancelled)
        assertEquals(1, fixture.transport.connections.size)
        advanceTimeBy(1_000)
        runCurrent()
        assertEquals(2, fixture.transport.connections.size)
    }

    @Test
    fun fullJitterCapsFollowSequenceAndResetAfterSixtySecondsConnected() = runTest {
        val fixture = Fixture()
        val client = fixture.client(monotonicMillis = { testScheduler.currentTime })
        backgroundScope.launch { client.run() }
        runCurrent()

        val expectedDelays = listOf(1_000L, 2_000L, 5_000L, 10_000L, 30_000L, 60_000L, 60_000L)
        expectedDelays.forEachIndexed { index, delayMillis ->
            fixture.transport.connections[index].emit(WsEvent.Failure(IOException("connection ended")))
            runCurrent()
            advanceTimeBy(delayMillis - 1)
            runCurrent()
            assertEquals(index + 1, fixture.transport.connections.size)
            advanceTimeBy(1)
            runCurrent()
            assertEquals(index + 2, fixture.transport.connections.size)
        }

        val stable = fixture.transport.connections.last()
        stable.emit(WsEvent.Opened)
        stable.emit(WsEvent.Text(serverText(readyFrame())))
        runCurrent()
        advanceTimeBy(60_000)
        runCurrent()
        stable.emit(WsEvent.Closed(NORMAL_CLOSE))
        runCurrent()
        advanceTimeBy(999)
        runCurrent()
        assertEquals(expectedDelays.size + 1, fixture.transport.connections.size)
        advanceTimeBy(1)
        runCurrent()
        assertEquals(expectedDelays.size + 2, fixture.transport.connections.size)
    }

    @Test
    fun networkReturnPreemptsBackoffAndReconnectsImmediately() = runTest {
        val fixture = Fixture()
        val client = fixture.client()

        client.state.test {
            assertEquals(ConnectionState.Reconnecting, awaitItem())
            backgroundScope.launch { client.run() }
            runCurrent()
            fixture.transport.connections.single().emit(WsEvent.Failure(IOException("connection ended")))
            runCurrent()

            fixture.network.setAvailable(false)
            runCurrent()
            assertEquals(ConnectionState.Offline, awaitItem())
            assertEquals(1, fixture.transport.connections.size)

            fixture.network.setAvailable(true)
            runCurrent()
            assertEquals(ConnectionState.Reconnecting, awaitItem())
            assertEquals(2, fixture.transport.connections.size)
            cancelAndIgnoreRemainingEvents()
        }
    }

    @Test
    fun unauthorizedSignsOutOnceAndNeverRetries() = runTest {
        val fixture = Fixture()
        var unauthorizedCalls = 0
        val client = fixture.client(onUnauthorized = { unauthorizedCalls += 1 })
        val run = backgroundScope.launch { client.run() }
        runCurrent()
        val connection = fixture.transport.connections.single()
        connection.emit(WsEvent.Closed(WS_CLOSE_UNAUTHORIZED))
        runCurrent()

        assertEquals(1, unauthorizedCalls)
        assertTrue(run.isCompleted)
        assertEquals(ConnectionState.Offline, client.state.value)
        advanceTimeBy(120_000)
        runCurrent()
        client.run()
        assertEquals(1, unauthorizedCalls)
        assertEquals(1, fixture.transport.connections.size)
    }

    @Test
    fun syncUnauthorizedSignsOutOnceAndNeverRetries() = runTest {
        val fixture = Fixture()
        var unauthorizedCalls = 0
        val client = fixture.client(
            onFrame = { throw ApiError.Unauthorized() },
            onUnauthorized = { unauthorizedCalls += 1 }
        )
        val run = backgroundScope.launch { client.run() }
        runCurrent()
        val connection = fixture.transport.connections.single()
        connection.emit(WsEvent.Opened)
        connection.emit(WsEvent.Text(serverText(readyFrame())))
        runCurrent()

        assertEquals(1, unauthorizedCalls)
        assertTrue(run.isCompleted)
        assertTrue(connection.cancelled)
        advanceTimeBy(120_000)
        runCurrent()
        assertEquals(1, fixture.transport.connections.size)
    }

    @Test
    fun restartingUsesRandomDelayBetweenOneAndThreeSeconds() = runTest {
        val requestedRanges = mutableListOf<LongRange>()
        val fixture = Fixture(
            randomDelayMillis = { range ->
                requestedRanges += range
                2_000L
            }
        )
        val client = fixture.client()
        backgroundScope.launch { client.run() }
        runCurrent()
        fixture.transport.connections.single().emit(WsEvent.Closed(WS_CLOSE_RESTARTING))
        runCurrent()

        assertEquals(listOf(1_000L..3_000L), requestedRanges)
        advanceTimeBy(1_999)
        runCurrent()
        assertEquals(1, fixture.transport.connections.size)
        advanceTimeBy(1)
        runCurrent()
        assertEquals(2, fixture.transport.connections.size)
    }

    @Test
    fun cancellationClosesSocketAndStaleEventsCannotAffectNextRun() = runTest {
        val fixture = Fixture()
        val client = fixture.client()
        val firstRun = backgroundScope.launch { client.run() }
        runCurrent()
        val first = fixture.transport.connections.single()

        firstRun.cancel()
        runCurrent()
        assertTrue(first.cancelled)
        assertFalse(first.emit(WsEvent.Opened))

        backgroundScope.launch { client.run() }
        runCurrent()
        val second = fixture.transport.connections.last()
        second.emit(WsEvent.Opened)
        runCurrent()
        assertTrue(first.sent.isEmpty())
        assertEquals(1, second.sent.size)
    }

    private class Fixture(
        initialNetworkAvailable: Boolean = true,
        val randomDelayMillis: (LongRange) -> Long = { range -> range.last }
    ) {
        val transport = FakeWsTransport()
        val network = FakeNetworkMonitor(initialNetworkAvailable)

        fun client(
            since: suspend () -> String? = { null },
            onFrame: suspend (ServerFrame) -> Unit = {},
            onUnauthorized: suspend () -> Unit = {},
            monotonicMillis: () -> Long = { 0L }
        ): WsClient = WsClient(
            transport = transport,
            network = network,
            session = WsSessionConfig(
                token = TOKEN,
                version = VERSION,
                since = since
            ),
            onFrame = onFrame,
            onUnauthorized = onUnauthorized,
            timing = WsReconnectTiming(
                monotonicMillis = monotonicMillis,
                randomDelayMillis = randomDelayMillis
            )
        )
    }

    private class FakeWsTransport : WsTransport {
        val connections = mutableListOf<FakeWsConnection>()

        override fun open(): WsConnection = FakeWsConnection().also(connections::add)
    }

    private class FakeWsConnection : WsConnection {
        private val eventChannel = Channel<WsEvent>(Channel.UNLIMITED)
        override val events: ReceiveChannel<WsEvent> = eventChannel
        val sent = mutableListOf<String>()
        val closes = mutableListOf<Pair<Int, String>>()
        var cancelled = false
            private set

        override fun send(text: String): Boolean {
            if (cancelled) return false
            sent += text
            return true
        }

        override fun close(code: Int, reason: String): Boolean {
            if (cancelled) return false
            closes += code to reason
            return true
        }

        override fun cancel() {
            cancelled = true
            eventChannel.close()
        }

        fun emit(event: WsEvent): Boolean = eventChannel.trySend(event).isSuccess
    }

    private class FakeNetworkMonitor(initiallyAvailable: Boolean) : NetworkMonitor {
        private val mutableAvailable = MutableStateFlow(initiallyAvailable)
        override val available: StateFlow<Boolean> = mutableAvailable.asStateFlow()

        fun setAvailable(value: Boolean) {
            mutableAvailable.value = value
        }

        override fun close() = Unit
    }

    private companion object {
        const val VERSION = "0.1.0"
        const val PUSH_ID = "018f0c6e-7a00-7000-8000-000000000002"
        const val NEXT_PUSH_ID = "018f0c6e-7a00-7000-8000-000000000003"
        const val DEVICE_ID = "018f0c6e-7a00-7000-8000-000000000001"
        const val TIMESTAMP = "2026-10-30T12:00:00.000Z"
        const val NORMAL_CLOSE = 1_000
        val TOKEN: String = Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(32))

        fun readyFrame(): ReadyFrame = ReadyFrame(type = "ready", deviceId = DEVICE_ID, serverTime = TIMESTAMP)

        fun serverText(frame: ServerFrame): String = ProtocolJson.encodeToString(ServerFrame.serializer(), frame)

        fun assertHello(value: String, expectedSince: String?) {
            val frame = ProtocolJson.decodeFromString(ClientFrame.serializer(), value)
            assertTrue(frame is HelloFrame)
            frame as HelloFrame
            assertEquals(TOKEN, frame.token)
            assertEquals(expectedSince, frame.since)
            assertEquals(Platform.ANDROID, frame.client.platform)
            assertEquals(VERSION, frame.client.version)
        }
    }
}
