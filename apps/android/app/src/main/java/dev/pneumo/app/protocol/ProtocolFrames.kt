package dev.pneumo.app.protocol

import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

private const val WEB_PUSH_TYPE_PUSH = "push"
private const val WEB_PUSH_TYPE_REF = "ref"
private const val FRAME_HELLO = "hello"
private const val FRAME_PONG = "pong"
private const val FRAME_READY = "ready"
private const val FRAME_PUSH = "push"
private const val FRAME_PUSH_DELETED = "push_deleted"
private const val FRAME_DEVICE_ADDED = "device_added"
private const val FRAME_DEVICE_UPDATED = "device_updated"
private const val FRAME_DEVICE_REMOVED = "device_removed"
private const val FRAME_REPLAY_DONE = "replay_done"
private const val FRAME_RESYNC = "resync"
private const val FRAME_PING = "ping"
private const val TOKEN_BYTES = 32

sealed class WebPushPayload {
    companion object {
        fun serializer(): KSerializer<WebPushPayload> = WebPushPayloadSerializer
    }
}

@Serializable
data class WebPushPushPayload(val t: String, val push: PushDTO) : WebPushPayload() {
    init {
        require(t == WEB_PUSH_TYPE_PUSH) { "t must be push" }
    }
}

@Serializable
data class WebPushRefPayload(val t: String, val id: String) : WebPushPayload() {
    init {
        require(t == WEB_PUSH_TYPE_REF) { "t must be ref" }
        requireUuidV7(id, "id")
    }
}

object WebPushPayloadSerializer : KSerializer<WebPushPayload> {
    override val descriptor: SerialDescriptor = WebPushPushPayload.serializer().descriptor

    override fun deserialize(decoder: Decoder): WebPushPayload {
        val jsonDecoder = decoder.asJsonDecoder()
        val element = jsonDecoder.decodeJsonElement()
        return when (element.jsonObject["t"]?.jsonPrimitive?.content) {
            WEB_PUSH_TYPE_PUSH -> jsonDecoder.json.decodeFromJsonElement(WebPushPushPayload.serializer(), element)
            WEB_PUSH_TYPE_REF -> jsonDecoder.json.decodeFromJsonElement(WebPushRefPayload.serializer(), element)
            null -> throw SerializationException("WebPushPayload.t is required")
            else -> throw SerializationException("Unknown WebPushPayload.t")
        }
    }

    override fun serialize(encoder: Encoder, value: WebPushPayload) {
        val jsonEncoder = encoder.asJsonEncoder()
        val element = when (value) {
            is WebPushPushPayload -> jsonEncoder.json.encodeToJsonElement(WebPushPushPayload.serializer(), value)
            is WebPushRefPayload -> jsonEncoder.json.encodeToJsonElement(WebPushRefPayload.serializer(), value)
        }
        jsonEncoder.encodeJsonElement(element)
    }
}

sealed class ClientFrame {
    companion object {
        fun serializer(): KSerializer<ClientFrame> = ClientFrameSerializer
    }
}

@Serializable
data class ClientInfo(val platform: Platform, val version: String)

@Serializable
class HelloFrame(val type: String, val token: String, val since: String?, val client: ClientInfo) : ClientFrame() {
    init {
        require(type == FRAME_HELLO) { "type must be hello" }
        requireEncodedBytes(token, TOKEN_BYTES, "token")
        since?.let { requireUuidV7(it, "since") }
    }
}

@Serializable
data class PongFrame(val type: String) : ClientFrame() {
    init {
        require(type == FRAME_PONG) { "type must be pong" }
    }
}

object ClientFrameSerializer : KSerializer<ClientFrame> {
    override val descriptor: SerialDescriptor = HelloFrame.serializer().descriptor

    override fun deserialize(decoder: Decoder): ClientFrame {
        val jsonDecoder = decoder.asJsonDecoder()
        val element = jsonDecoder.decodeJsonElement()
        return when (element.jsonObject["type"]?.jsonPrimitive?.content) {
            FRAME_HELLO -> jsonDecoder.json.decodeFromJsonElement(HelloFrame.serializer(), element)
            FRAME_PONG -> jsonDecoder.json.decodeFromJsonElement(PongFrame.serializer(), element)
            null -> throw SerializationException("ClientFrame.type is required")
            else -> throw SerializationException("Unknown ClientFrame.type")
        }
    }

    override fun serialize(encoder: Encoder, value: ClientFrame) {
        val jsonEncoder = encoder.asJsonEncoder()
        val element = when (value) {
            is HelloFrame -> jsonEncoder.json.encodeToJsonElement(HelloFrame.serializer(), value)
            is PongFrame -> jsonEncoder.json.encodeToJsonElement(PongFrame.serializer(), value)
        }
        jsonEncoder.encodeJsonElement(element)
    }
}

sealed class ServerFrame {
    companion object {
        fun serializer(): KSerializer<ServerFrame> = ServerFrameSerializer
    }
}

@Serializable
data class ReadyFrame(val type: String, val deviceId: String, val serverTime: String) : ServerFrame() {
    init {
        require(type == FRAME_READY) { "type must be ready" }
        requireUuidV7(deviceId, "deviceId")
        requireIsoTimestamp(serverTime, "serverTime")
    }
}

@Serializable
data class PushFrame(val type: String, val push: PushDTO) : ServerFrame() {
    init {
        require(type == FRAME_PUSH) { "type must be push" }
    }
}

@Serializable
data class PushDeletedFrame(val type: String, val id: String) : ServerFrame() {
    init {
        require(type == FRAME_PUSH_DELETED) { "type must be push_deleted" }
        requireUuidV7(id, "id")
    }
}

@Serializable
data class DeviceAddedFrame(val type: String, val device: DeviceDTO) : ServerFrame() {
    init {
        require(type == FRAME_DEVICE_ADDED) { "type must be device_added" }
    }
}

@Serializable
data class DeviceUpdatedFrame(val type: String, val device: DeviceDTO) : ServerFrame() {
    init {
        require(type == FRAME_DEVICE_UPDATED) { "type must be device_updated" }
    }
}

@Serializable
data class DeviceRemovedFrame(val type: String, val id: String) : ServerFrame() {
    init {
        require(type == FRAME_DEVICE_REMOVED) { "type must be device_removed" }
        requireUuidV7(id, "id")
    }
}

@Serializable
data class ReplayDoneFrame(val type: String) : ServerFrame() {
    init {
        require(type == FRAME_REPLAY_DONE) { "type must be replay_done" }
    }
}

@Serializable
data class ResyncFrame(val type: String) : ServerFrame() {
    init {
        require(type == FRAME_RESYNC) { "type must be resync" }
    }
}

@Serializable
data class PingFrame(val type: String) : ServerFrame() {
    init {
        require(type == FRAME_PING) { "type must be ping" }
    }
}

object ServerFrameSerializer : KSerializer<ServerFrame> {
    override val descriptor: SerialDescriptor = ReadyFrame.serializer().descriptor

    override fun deserialize(decoder: Decoder): ServerFrame {
        val jsonDecoder = decoder.asJsonDecoder()
        val element = jsonDecoder.decodeJsonElement()
        return when (element.jsonObject["type"]?.jsonPrimitive?.content) {
            FRAME_READY -> jsonDecoder.json.decodeFromJsonElement(ReadyFrame.serializer(), element)
            FRAME_PUSH -> jsonDecoder.json.decodeFromJsonElement(PushFrame.serializer(), element)
            FRAME_PUSH_DELETED -> jsonDecoder.json.decodeFromJsonElement(PushDeletedFrame.serializer(), element)
            FRAME_DEVICE_ADDED -> jsonDecoder.json.decodeFromJsonElement(DeviceAddedFrame.serializer(), element)
            FRAME_DEVICE_UPDATED -> jsonDecoder.json.decodeFromJsonElement(DeviceUpdatedFrame.serializer(), element)
            FRAME_DEVICE_REMOVED -> jsonDecoder.json.decodeFromJsonElement(DeviceRemovedFrame.serializer(), element)
            FRAME_REPLAY_DONE -> jsonDecoder.json.decodeFromJsonElement(ReplayDoneFrame.serializer(), element)
            FRAME_RESYNC -> jsonDecoder.json.decodeFromJsonElement(ResyncFrame.serializer(), element)
            FRAME_PING -> jsonDecoder.json.decodeFromJsonElement(PingFrame.serializer(), element)
            null -> throw SerializationException("ServerFrame.type is required")
            else -> throw SerializationException("Unknown ServerFrame.type")
        }
    }

    override fun serialize(encoder: Encoder, value: ServerFrame) {
        val jsonEncoder = encoder.asJsonEncoder()
        val element = when (value) {
            is ReadyFrame -> jsonEncoder.json.encodeToJsonElement(ReadyFrame.serializer(), value)
            is PushFrame -> jsonEncoder.json.encodeToJsonElement(PushFrame.serializer(), value)
            is PushDeletedFrame -> jsonEncoder.json.encodeToJsonElement(PushDeletedFrame.serializer(), value)
            is DeviceAddedFrame -> jsonEncoder.json.encodeToJsonElement(DeviceAddedFrame.serializer(), value)
            is DeviceUpdatedFrame -> jsonEncoder.json.encodeToJsonElement(DeviceUpdatedFrame.serializer(), value)
            is DeviceRemovedFrame -> jsonEncoder.json.encodeToJsonElement(DeviceRemovedFrame.serializer(), value)
            is ReplayDoneFrame -> jsonEncoder.json.encodeToJsonElement(ReplayDoneFrame.serializer(), value)
            is ResyncFrame -> jsonEncoder.json.encodeToJsonElement(ResyncFrame.serializer(), value)
            is PingFrame -> jsonEncoder.json.encodeToJsonElement(PingFrame.serializer(), value)
        }
        jsonEncoder.encodeJsonElement(element)
    }
}

private fun Decoder.asJsonDecoder(): JsonDecoder =
    this as? JsonDecoder ?: throw SerializationException("Protocol frames require JSON")

private fun Encoder.asJsonEncoder(): JsonEncoder =
    this as? JsonEncoder ?: throw SerializationException("Protocol frames require JSON")
