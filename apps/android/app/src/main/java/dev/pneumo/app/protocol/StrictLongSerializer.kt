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
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive

/** JSON numbers only; the query-string serializer deliberately handles coercion separately. */
internal object StrictLongSerializer : KSerializer<Long> {
    override val descriptor: SerialDescriptor = PrimitiveSerialDescriptor("ProtocolInteger", PrimitiveKind.LONG)

    override fun deserialize(decoder: Decoder): Long {
        val json = decoder as? JsonDecoder ?: throw SerializationException("Protocol integers require JSON")
        val primitive = json.decodeJsonElement() as? JsonPrimitive
        val content = primitive?.takeIf { it !is JsonNull && !it.isString }?.content
            ?: throw SerializationException("Expected a JSON integer")
        return exactInteger(content)
    }

    override fun serialize(encoder: Encoder, value: Long) {
        encoder.encodeLong(value)
    }

    private fun exactInteger(content: String): Long {
        content.toLongOrNull()?.let { return it }
        val value = try {
            BigDecimal(content).longValueExact()
        } catch (ignored: NumberFormatException) {
            null
        } catch (ignored: ArithmeticException) {
            null
        }
        return value ?: throw SerializationException("Expected a JSON integer")
    }
}
