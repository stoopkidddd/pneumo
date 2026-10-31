package dev.pneumo.app.net.ws

import dev.pneumo.app.protocol.ClientInfo
import dev.pneumo.app.protocol.HelloFrame
import dev.pneumo.app.protocol.Platform

class WsSessionConfig(
    private val token: String,
    private val version: String,
    private val since: suspend () -> String?
) {
    internal suspend fun helloFrame(): HelloFrame = HelloFrame(
        type = "hello",
        token = token,
        since = since(),
        client = ClientInfo(platform = Platform.ANDROID, version = version)
    )

    override fun toString(): String = "WsSessionConfig(token=<redacted>, version=$version, since=<redacted>)"
}
