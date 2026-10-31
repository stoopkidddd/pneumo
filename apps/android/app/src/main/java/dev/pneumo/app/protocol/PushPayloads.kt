@file:kotlinx.serialization.UseSerializers(StrictLongSerializer::class)

package dev.pneumo.app.protocol

import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

private const val NOTE_TYPE = "note"
private const val LINK_TYPE = "link"
private const val FILE_TYPE = "file"
private const val PAYLOAD_KEY_BYTES = 32

sealed class PushPayload {
    companion object {
        fun serializer(): KSerializer<PushPayload> = PushPayloadSerializer
    }
}

@Serializable(with = NotePayloadSerializer::class)
class NotePayload(val type: String, val title: String? = null, val body: String) : PushPayload() {
    constructor(title: String? = null, body: String) : this(NOTE_TYPE, title, body)

    init {
        require(type == NOTE_TYPE) { "type must be note" }
    }
}

@Serializable(with = LinkPayloadSerializer::class)
class LinkPayload(val type: String, val title: String? = null, val body: String? = null, val url: String) :
    PushPayload() {
    constructor(title: String? = null, body: String? = null, url: String) :
        this(LINK_TYPE, title, body, url)

    init {
        require(type == LINK_TYPE) { "type must be link" }
        requireHttpUrl(url, "url")
    }
}

@Serializable
class PayloadFile(val name: String, val mime: String, val size: Long, val key: String) {
    init {
        requireByteCount(size, "file.size")
        requireEncodedBytes(key, PAYLOAD_KEY_BYTES, "file.key")
    }
}

@Serializable(with = FilePayloadSerializer::class)
class FilePayload(val type: String, val title: String? = null, val body: String? = null, val file: PayloadFile) :
    PushPayload() {
    constructor(title: String? = null, body: String? = null, file: PayloadFile) :
        this(FILE_TYPE, title, body, file)

    init {
        require(type == FILE_TYPE) { "type must be file" }
    }
}

@Serializable
private class NotePayloadWire(val type: String, val title: String? = null, val body: String)

@Serializable
private class LinkPayloadWire(val type: String, val title: String? = null, val body: String? = null, val url: String)

@Serializable
private class FilePayloadWire(
    val type: String,
    val title: String? = null,
    val body: String? = null,
    val file: PayloadFile
)

object NotePayloadSerializer : KSerializer<NotePayload> {
    override val descriptor: SerialDescriptor = NotePayloadWire.serializer().descriptor

    override fun deserialize(decoder: Decoder): NotePayload {
        val jsonDecoder = decoder.requireJsonDecoder()
        val element = jsonDecoder.decodeJsonElement()
        element.rejectExplicitNull("title")
        val wire = jsonDecoder.json.decodeFromJsonElement(NotePayloadWire.serializer(), element)
        return NotePayload(wire.type, wire.title, wire.body)
    }

    override fun serialize(encoder: Encoder, value: NotePayload) {
        val jsonEncoder = encoder.requireJsonEncoder()
        val wire = NotePayloadWire(value.type, value.title, value.body)
        jsonEncoder.encodeJsonElement(jsonEncoder.json.encodeToJsonElement(NotePayloadWire.serializer(), wire))
    }
}

object LinkPayloadSerializer : KSerializer<LinkPayload> {
    override val descriptor: SerialDescriptor = LinkPayloadWire.serializer().descriptor

    override fun deserialize(decoder: Decoder): LinkPayload {
        val jsonDecoder = decoder.requireJsonDecoder()
        val element = jsonDecoder.decodeJsonElement()
        element.rejectExplicitNull("title", "body")
        val wire = jsonDecoder.json.decodeFromJsonElement(LinkPayloadWire.serializer(), element)
        return LinkPayload(wire.type, wire.title, wire.body, wire.url)
    }

    override fun serialize(encoder: Encoder, value: LinkPayload) {
        val jsonEncoder = encoder.requireJsonEncoder()
        val wire = LinkPayloadWire(value.type, value.title, value.body, value.url)
        jsonEncoder.encodeJsonElement(jsonEncoder.json.encodeToJsonElement(LinkPayloadWire.serializer(), wire))
    }
}

object FilePayloadSerializer : KSerializer<FilePayload> {
    override val descriptor: SerialDescriptor = FilePayloadWire.serializer().descriptor

    override fun deserialize(decoder: Decoder): FilePayload {
        val jsonDecoder = decoder.requireJsonDecoder()
        val element = jsonDecoder.decodeJsonElement()
        element.rejectExplicitNull("title", "body")
        val wire = jsonDecoder.json.decodeFromJsonElement(FilePayloadWire.serializer(), element)
        return FilePayload(wire.type, wire.title, wire.body, wire.file)
    }

    override fun serialize(encoder: Encoder, value: FilePayload) {
        val jsonEncoder = encoder.requireJsonEncoder()
        val wire = FilePayloadWire(value.type, value.title, value.body, value.file)
        jsonEncoder.encodeJsonElement(jsonEncoder.json.encodeToJsonElement(FilePayloadWire.serializer(), wire))
    }
}

object PushPayloadSerializer : KSerializer<PushPayload> {
    override val descriptor: SerialDescriptor = NotePayloadWire.serializer().descriptor

    override fun deserialize(decoder: Decoder): PushPayload {
        val jsonDecoder = decoder.requireJsonDecoder()
        val element = jsonDecoder.decodeJsonElement()
        val type = element.jsonObject["type"]?.jsonPrimitive?.content
            ?: throw SerializationException("PushPayload.type is required")
        return when (type) {
            NOTE_TYPE -> jsonDecoder.json.decodeFromJsonElement(NotePayload.serializer(), element)
            LINK_TYPE -> jsonDecoder.json.decodeFromJsonElement(LinkPayload.serializer(), element)
            FILE_TYPE -> jsonDecoder.json.decodeFromJsonElement(FilePayload.serializer(), element)
            else -> throw SerializationException("Unknown PushPayload.type: $type")
        }
    }

    override fun serialize(encoder: Encoder, value: PushPayload) {
        val jsonEncoder = encoder.requireJsonEncoder()
        val element = when (value) {
            is NotePayload -> jsonEncoder.json.encodeToJsonElement(NotePayload.serializer(), value)
            is LinkPayload -> jsonEncoder.json.encodeToJsonElement(LinkPayload.serializer(), value)
            is FilePayload -> jsonEncoder.json.encodeToJsonElement(FilePayload.serializer(), value)
        }
        jsonEncoder.encodeJsonElement(element)
    }
}

private fun Decoder.requireJsonDecoder(): JsonDecoder =
    this as? JsonDecoder ?: throw SerializationException("Protocol payloads require JSON")

private fun Encoder.requireJsonEncoder(): JsonEncoder =
    this as? JsonEncoder ?: throw SerializationException("Protocol payloads require JSON")

private fun JsonElement.rejectExplicitNull(vararg names: String) {
    val objectValue = jsonObject
    names.forEach { name ->
        if (objectValue[name] is JsonNull) throw SerializationException("$name must be a string when present")
    }
}
