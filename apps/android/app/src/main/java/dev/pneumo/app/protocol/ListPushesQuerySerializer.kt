package dev.pneumo.app.protocol

import java.math.BigDecimal
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerializationException
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

object ListPushesQuerySerializer : KSerializer<ListPushesQuery> {
    override val descriptor: SerialDescriptor =
        PrimitiveSerialDescriptor("dev.pneumo.app.protocol.ListPushesQuery", PrimitiveKind.STRING)

    override fun deserialize(decoder: Decoder): ListPushesQuery {
        val jsonDecoder = decoder as? JsonDecoder
            ?: throw SerializationException("ListPushesQuery requires JSON")
        val value = jsonDecoder.decodeJsonElement().jsonObject
        val before = when (val element = value["before"]) {
            null -> null

            JsonNull -> throw SerializationException("before must be a UUIDv7 when present")

            is JsonPrimitive -> {
                if (!element.isString) throw SerializationException("before must be a string")
                element.content
            }

            else -> throw SerializationException("before must be a string")
        }
        val limit = value["limit"]?.coerceLong() ?: DEFAULT_PUSH_LIMIT
        return ListPushesQuery(before, limit)
    }

    override fun serialize(encoder: Encoder, value: ListPushesQuery) {
        val jsonEncoder = encoder as? JsonEncoder
            ?: throw SerializationException("ListPushesQuery requires JSON")
        val properties = buildMap<String, JsonPrimitive> {
            value.before?.let { put("before", JsonPrimitive(it)) }
            if (value.limit != DEFAULT_PUSH_LIMIT) put("limit", JsonPrimitive(value.limit))
        }
        jsonEncoder.encodeJsonElement(JsonObject(properties))
    }
}

private fun kotlinx.serialization.json.JsonElement.coerceLong(): Long {
    val primitive = this as? JsonPrimitive
    val content = primitive?.takeIf { it !is JsonNull && it.booleanOrNull == null }?.content
        ?: throw SerializationException("limit must be a string or number")
    val number = try {
        BigDecimal(content).stripTrailingZeros().longValueExact()
    } catch (ignored: NumberFormatException) {
        null
    } catch (ignored: ArithmeticException) {
        null
    }
    return number ?: throw SerializationException("limit must be an integer")
}
