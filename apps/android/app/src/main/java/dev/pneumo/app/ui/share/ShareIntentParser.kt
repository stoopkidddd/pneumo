package dev.pneumo.app.ui.share

import android.content.Intent
import android.net.Uri
import androidx.core.content.IntentCompat

internal data class SharedText(val body: String, val title: String?)

internal sealed interface ParsedShare {
    data class Valid(val text: SharedText) : ParsedShare

    data class Files(val uris: List<Uri>, val mime: String?, val text: SharedText) : ParsedShare

    data object Invalid : ParsedShare
}

internal object ShareIntentParser {
    fun parse(intent: Intent): ParsedShare {
        val streams = when (intent.action) {
            Intent.ACTION_SEND -> listOfNotNull(
                IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)
            )

            Intent.ACTION_SEND_MULTIPLE ->
                IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri::class.java).orEmpty()

            else -> emptyList()
        }
        if (streams.isNotEmpty()) {
            return ParsedShare.Files(
                uris = streams,
                mime = intent.type,
                text = SharedText(
                    body = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString().orEmpty(),
                    title = intent.getCharSequenceExtra(Intent.EXTRA_SUBJECT)?.toString()
                )
            )
        }
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
