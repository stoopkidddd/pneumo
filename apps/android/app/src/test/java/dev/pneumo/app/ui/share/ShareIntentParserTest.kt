package dev.pneumo.app.ui.share

import android.content.Intent
import dev.pneumo.app.data.TextPushes
import dev.pneumo.app.protocol.LinkPayload
import dev.pneumo.app.protocol.NotePayload
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ShareIntentParserTest {
    @Test
    fun plainTextBecomesNoteWithoutChangingBody() {
        val parsed = ShareIntentParser.parse(shareIntent("A note with spacing  ")) as ParsedShare.Valid

        val payload = TextPushes.payload(parsed.text.body, parsed.text.title)

        assertTrue(payload is NotePayload)
        assertEquals("A note with spacing  ", (payload as NotePayload).body)
        assertNull(payload.title)
    }

    @Test
    fun urlOnlyBecomesLink() {
        val parsed = ShareIntentParser.parse(shareIntent("https://example.com/path?q=1")) as ParsedShare.Valid

        val payload = TextPushes.payload(parsed.text.body, parsed.text.title)

        assertTrue(payload is LinkPayload)
        assertEquals("https://example.com/path?q=1", (payload as LinkPayload).url)
        assertNull(payload.body)
    }

    @Test
    fun urlAndSubjectBecomeTitledLink() {
        val parsed = ShareIntentParser.parse(
            shareIntent("https://example.com", subject = "Useful page")
        ) as ParsedShare.Valid

        val payload = TextPushes.payload(parsed.text.body, parsed.text.title)

        assertTrue(payload is LinkPayload)
        assertEquals("Useful page", (payload as LinkPayload).title)
        assertEquals("https://example.com", payload.url)
    }

    @Test
    fun extraMessageBecomesLinkBody() {
        val parsed = ShareIntentParser.parse(shareIntent("https://example.com")) as ParsedShare.Valid

        val payload = TextPushes.payload(parsed.text.body, parsed.text.title, "Read this later")

        assertTrue(payload is LinkPayload)
        assertEquals("Read this later", (payload as LinkPayload).body)
    }

    @Test
    fun multilineTextContainingUrlRemainsNote() {
        val body = "Read this:\nhttps://example.com"
        val parsed = ShareIntentParser.parse(shareIntent(body)) as ParsedShare.Valid

        val payload = TextPushes.payload(parsed.text.body, parsed.text.title)

        assertTrue(payload is NotePayload)
        assertEquals(body, (payload as NotePayload).body)
    }

    @Test
    fun extraMessageIsAppendedToSharedNote() {
        val parsed = ShareIntentParser.parse(shareIntent("Original note")) as ParsedShare.Valid

        val payload = TextPushes.payload(parsed.text.body, parsed.text.title, "Added from the share sheet")

        assertTrue(payload is NotePayload)
        assertEquals("Original note\nAdded from the share sheet", (payload as NotePayload).body)
    }

    @Test
    fun blankTextIsInvalid() {
        assertTrue(ShareIntentParser.parse(shareIntent(" \n\t")) is ParsedShare.Invalid)
    }

    private fun shareIntent(text: String, subject: String? = null) = Intent(Intent.ACTION_SEND).apply {
        type = "text/plain"
        putExtra(Intent.EXTRA_TEXT, text)
        subject?.let { putExtra(Intent.EXTRA_SUBJECT, it) }
    }
}
