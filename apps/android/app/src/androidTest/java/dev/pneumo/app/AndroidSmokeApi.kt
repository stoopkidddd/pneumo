package dev.pneumo.app

import dev.pneumo.app.crypto.Base64Url
import dev.pneumo.app.protocol.CreatePushRequest
import dev.pneumo.app.protocol.DeviceDTO
import dev.pneumo.app.protocol.Limits
import dev.pneumo.app.protocol.ListDevicesResponse
import dev.pneumo.app.protocol.ListPushesResponse
import dev.pneumo.app.protocol.MeResponse
import dev.pneumo.app.protocol.Platform
import dev.pneumo.app.protocol.ProtocolJson
import dev.pneumo.app.protocol.PushDTO
import dev.pneumo.app.protocol.UploadMode
import java.io.Closeable
import java.io.IOException
import java.net.ServerSocket
import java.net.Socket
import java.util.Collections
import kotlin.concurrent.thread

/** Loopback HTTP boundary for the device smoke; requests contain real encrypted envelopes. */
internal class AndroidSmokeApi(private val failFirstPush: Boolean = false) : Closeable {
    private val server = ServerSocket(0)
    private val pushes = Collections.synchronizedList(mutableListOf<PushDTO>())
    private val requests = Collections.synchronizedList(mutableListOf<CreatePushRequest>())
    private val device = DeviceDTO(
        name = "Smoke phone",
        platform = Platform.ANDROID,
        id = DEVICE_ID,
        createdAt = CREATED_AT,
        lastSeenAt = CREATED_AT,
        online = true
    )
    val origin = "http://localhost:${server.localPort}"
    private val listener = thread(isDaemon = true, name = "android-smoke-api") {
        while (!server.isClosed) {
            try {
                val socket = server.accept()
                thread(isDaemon = true) { socket.use(::respond) }
            } catch (_: IOException) {
                // Closing the test's server stops accept.
            }
        }
    }

    fun receivedPushes(): List<CreatePushRequest> = synchronized(requests) { requests.toList() }

    private fun respond(socket: Socket) {
        val reader = socket.getInputStream().bufferedReader(Charsets.UTF_8)
        val start = reader.readLine()?.split(' ') ?: return
        var length = 0
        while (true) {
            val header = checkNotNull(reader.readLine()) { "Incomplete HTTP headers" }
            if (header.isEmpty()) break
            if (header.startsWith("Content-Length:", ignoreCase = true)) {
                length = header.substringAfter(':').trim().toInt()
            }
        }
        val body = CharArray(length)
        var offset = 0
        while (offset < length) {
            val count = reader.read(body, offset, length - offset)
            if (count < 0) return
            offset += count
        }
        val (status, response) = route(start[0], start[1].substringBefore('?'), String(body))
        val bytes = response.toByteArray(Charsets.UTF_8)
        socket.getOutputStream().apply {
            write(
                (
                    "HTTP/1.1 $status\r\nContent-Type: application/json\r\n" +
                        "Content-Length: ${bytes.size}\r\nConnection: close\r\n\r\n"
                    ).toByteArray()
            )
            write(bytes)
            flush()
        }
    }

    private fun route(method: String, path: String, body: String): Pair<String, String> = when {
        method == "GET" && path == "/api/me" -> "200 OK" to ProtocolJson.encodeToString(
            MeResponse.serializer(),
            MeResponse(
                device = device,
                keyCheck = Base64Url.encode(ByteArray(KEY_BYTES)),
                limits = Limits(MAX_FILE_BYTES, MAX_ENVELOPE_BYTES),
                vapidPublicKey = Base64Url.encode(ByteArray(PUBLIC_KEY_BYTES)),
                uploadMode = UploadMode.PROXY
            )
        )

        method == "GET" && path == "/api/devices" -> "200 OK" to ProtocolJson.encodeToString(
            ListDevicesResponse.serializer(),
            ListDevicesResponse(listOf(device))
        )

        method == "GET" && path == "/api/pushes" -> "200 OK" to ProtocolJson.encodeToString(
            ListPushesResponse.serializer(),
            ListPushesResponse(synchronized(pushes) { pushes.toList().reversed() }, null)
        )

        method == "POST" && path == "/api/pushes" -> create(body)

        else -> "404 Not Found" to """{"error":{"code":"not_found","message":"Not found"}}"""
    }

    private fun create(body: String): Pair<String, String> {
        val request = ProtocolJson.decodeFromString(CreatePushRequest.serializer(), body)
        val firstRequest = synchronized(requests) {
            requests.add(request)
            requests.size == 1
        }
        if (failFirstPush && firstRequest) {
            return "503 Service Unavailable" to """{"error":{"code":"internal","message":"Try later"}}"""
        }
        val push = PushDTO(
            id = request.id,
            createdAt = CREATED_AT,
            sourceDeviceId = DEVICE_ID,
            targetDeviceId = request.targetDeviceId,
            envelope = request.envelope,
            file = null
        )
        pushes.add(push)
        return "201 Created" to ProtocolJson.encodeToString(PushDTO.serializer(), push)
    }

    override fun close() {
        server.close()
        listener.join(JOIN_TIMEOUT_MS)
    }

    companion object {
        const val DEVICE_ID = "0192e7ce-7c00-7000-8000-000000000001"
        private const val CREATED_AT = "2026-10-31T12:00:00.000Z"
        private const val KEY_BYTES = 32
        private const val PUBLIC_KEY_BYTES = 65
        private const val MAX_FILE_BYTES = 524_288_000L
        private const val MAX_ENVELOPE_BYTES = 65_536L
        private const val JOIN_TIMEOUT_MS = 1000L
    }
}
