package dev.pneumo.app.net.ws

import kotlinx.coroutines.channels.ReceiveChannel

interface WsTransport {
    fun open(): WsConnection
}

interface WsConnection {
    val events: ReceiveChannel<WsEvent>

    fun send(text: String): Boolean

    fun close(code: Int, reason: String): Boolean

    fun cancel()
}

sealed interface WsEvent {
    data object Opened : WsEvent

    data class Text(val value: String) : WsEvent

    data class Closed(val code: Int) : WsEvent

    data class Failure(val cause: Throwable) : WsEvent
}
