package dev.pneumo.app.data

import dev.pneumo.app.crypto.PushCrypto
import dev.pneumo.app.protocol.Envelope
import dev.pneumo.app.protocol.LinkPayload
import dev.pneumo.app.protocol.NotePayload
import dev.pneumo.app.protocol.ProtocolJson
import javax.crypto.spec.SecretKeySpec
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

class TextPushesTest {
    private val key = SecretKeySpec(ByteArray(KEY_BYTES), "AES")

    @Test
    fun envelopeLimitCountsSerializedEncryptedUtf8BytesInclusively() {
        val payload = TextPushes.payload("Résumé 日本語")
        val request = TextPushes.request(payload, null, key, MAX_ENVELOPE_BYTES)
        val exactSize = ProtocolJson.encodeToString(Envelope.serializer(), request.envelope)
            .toByteArray(Charsets.UTF_8).size.toLong()
        val accepted = TextPushes.request(payload, null, key, exactSize)
        assertEquals("Résumé 日本語", (PushCrypto.decrypt(key, accepted.id, accepted.envelope) as NotePayload).body)
        assertThrows(IllegalArgumentException::class.java) {
            TextPushes.request(payload, null, key, exactSize - 1)
        }
    }

    @Test
    fun linkKeepsSubjectAndOptionalMessageButOmitsBlankFields() {
        val payload = TextPushes.payload(" https://example.com ", "Example", "Read this") as LinkPayload
        assertEquals("https://example.com", payload.url)
        assertEquals("Example", payload.title)
        assertEquals("Read this", payload.body)
        val blank = TextPushes.payload("https://example.com", "  ", "\n") as LinkPayload
        assertNull(blank.title)
        assertNull(blank.body)
    }

    @Test
    fun multilineNotePreservesBodyAndAppendsOptionalMessage() {
        val payload = TextPushes.payload("See this:\nhttps://example.com", message = "Later") as NotePayload
        assertEquals("See this:\nhttps://example.com\nLater", payload.body)
    }

    @Test
    fun emptyMessageCannotBeEncryptedAsASend() {
        assertThrows(IllegalArgumentException::class.java) { TextPushes.payload(" \n\t") }
    }

    private companion object {
        const val KEY_BYTES = 32
        const val MAX_ENVELOPE_BYTES = 65_536L
    }
}
