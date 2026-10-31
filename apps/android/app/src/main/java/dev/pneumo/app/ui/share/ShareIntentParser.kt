package dev.pneumo.app.ui.share

import android.content.Intent

internal data class SharedText(val body: String, val title: String?)

internal sealed interface ParsedShare {
    data class Valid(val text: SharedText) : ParsedShare

    data object Invalid : ParsedShare
}

internal object ShareIntentParser {
    fun parse(intent: Intent): ParsedShare {
        val supported = intent.action == Intent.ACTION_SEND && intent.type == MIME_TEXT
        val body = if (supported) {
            intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString().orEmpty()
        } else {
            ""
        }
        return if (body.isBlank()) {
            ParsedShare.Invalid
        } else {
            val title = intent.getCharSequenceExtra(Intent.EXTRA_SUBJECT)?.toString()
            ParsedShare.Valid(SharedText(body = body, title = title))
        }
    }

    private const val MIME_TEXT = "text/plain"
}
