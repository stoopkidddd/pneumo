package dev.pneumo.app.net.ws

import dev.pneumo.app.protocol.WS_CLOSE_PROTOCOL_ERROR
import java.net.ProtocolException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.ReceiveChannel
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString

class OkHttpWsTransport(origin: HttpUrl, httpClient: OkHttpClient) : WsTransport {
    private val request: Request
    private val client =
        httpClient.newBuilder()
            .followRedirects(false)
            .followSslRedirects(false)
            .pingInterval(0, TimeUnit.MILLISECONDS)
            .build()

    init {
        require(origin.scheme == HTTP_SCHEME || origin.scheme == HTTPS_SCHEME) {
            "Server origin must use HTTP or HTTPS"
        }
        require(
            origin.username.isEmpty() &&
                origin.password.isEmpty() &&
                origin.encodedPath == ROOT_PATH &&
                origin.query == null &&
                origin.fragment == null
        ) {
            "Server URL must be an origin without credentials, path, query, or fragment"
        }
        request = Request.Builder().url(origin.newBuilder().encodedPath(WS_PATH).build()).build()
    }

    constructor(origin: String, httpClient: OkHttpClient) : this(origin.toHttpUrl(), httpClient)

    override fun open(): WsConnection = OkHttpWsConnection(client, request)

    private companion object {
        const val HTTP_SCHEME = "http"
        const val HTTPS_SCHEME = "https"
        const val ROOT_PATH = "/"
        const val WS_PATH = "/api/ws"
    }
}

private class OkHttpWsConnection(client: OkHttpClient, request: Request) : WsConnection {
    private val eventChannel = Channel<WsEvent>(Channel.UNLIMITED)
    private val cancelled = AtomicBoolean(false)
    private val webSocket: WebSocket = client.newWebSocket(request, Listener())

    override val events: ReceiveChannel<WsEvent> = eventChannel

    override fun send(text: String): Boolean = webSocket.send(text)

    override fun close(code: Int, reason: String): Boolean = webSocket.close(code, reason)

    override fun cancel() {
        if (cancelled.compareAndSet(false, true)) {
            webSocket.cancel()
            eventChannel.close()
        }
    }

    private inner class Listener : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            eventChannel.trySend(WsEvent.Opened)
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            eventChannel.trySend(WsEvent.Text(text))
        }

        override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
            eventChannel.trySend(WsEvent.Failure(ProtocolException("Binary WebSocket frame")))
            webSocket.close(WS_CLOSE_PROTOCOL_ERROR, PROTOCOL_ERROR_REASON)
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            eventChannel.trySend(WsEvent.Closed(code))
            webSocket.close(code, EMPTY_REASON)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            eventChannel.trySend(WsEvent.Closed(code))
            eventChannel.close()
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            response?.close()
            eventChannel.trySend(WsEvent.Failure(t))
            eventChannel.close()
        }
    }

    private companion object {
        const val EMPTY_REASON = ""
        const val PROTOCOL_ERROR_REASON = "Protocol error"
    }
}
