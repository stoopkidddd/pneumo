package dev.pneumo.app.data

import dev.pneumo.app.crypto.PushCrypto
import dev.pneumo.app.crypto.Uuidv7
import dev.pneumo.app.protocol.CreatePushRequest
import dev.pneumo.app.protocol.Envelope
import dev.pneumo.app.protocol.LinkPayload
import dev.pneumo.app.protocol.NotePayload
import dev.pneumo.app.protocol.ProtocolJson
import dev.pneumo.app.protocol.PushPayload
import dev.pneumo.app.protocol.requireHttpUrl
import javax.crypto.SecretKey

object TextPushes {
    fun payload(text: String, title: String? = null, message: String? = null): PushPayload {
        require(text.isNotBlank()) { "Enter some text to send." }
        val optionalTitle = title?.takeIf(String::isNotBlank)
        val optionalMessage = message?.takeIf(String::isNotBlank)
        val trimmed = text.trim()
        val isLink = try {
            requireHttpUrl(trimmed, "url")
            true
        } catch (_: IllegalArgumentException) {
            false
        }
        return if (isLink) {
            LinkPayload(title = optionalTitle, body = optionalMessage, url = trimmed)
        } else {
            NotePayload(
                title = optionalTitle,
                body = if (optionalMessage == null) text else "$text\n$optionalMessage"
            )
        }
    }

    fun request(
        payload: PushPayload,
        targetDeviceId: String?,
        contentKey: SecretKey,
        maxEnvelopeBytes: Long
    ): CreatePushRequest {
        val id = Uuidv7.generate()
        val envelope = PushCrypto.encrypt(contentKey, id, payload)
        // The envelope contains only JSON punctuation, an integer, and ASCII base64url.
        val byteCount = ProtocolJson.encodeToString(Envelope.serializer(), envelope).length
        require(byteCount <= maxEnvelopeBytes) { "This message is too large. Shorten it and try again." }
        return CreatePushRequest(id = id, targetDeviceId = targetDeviceId, envelope = envelope, file = null)
    }
}
