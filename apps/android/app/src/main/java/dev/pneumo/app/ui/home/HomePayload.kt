package dev.pneumo.app.ui.home

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.text.format.Formatter
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Create
import androidx.compose.material.icons.filled.Email
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import dev.pneumo.app.R
import dev.pneumo.app.protocol.FilePayload
import dev.pneumo.app.protocol.LinkPayload
import dev.pneumo.app.protocol.NotePayload
import dev.pneumo.app.protocol.PushPayload
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

@Composable
internal fun PushContents(payload: PushPayload) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        when (payload) {
            is NotePayload -> {
                payload.title?.let { title ->
                    Text(text = title, style = MaterialTheme.typography.titleSmall)
                }
                Text(text = payload.body, style = MaterialTheme.typography.bodyLarge)
            }

            is LinkPayload -> {
                payload.title?.let { title ->
                    Text(text = title, style = MaterialTheme.typography.titleSmall)
                }
                Text(
                    text = payload.url,
                    color = MaterialTheme.colorScheme.primary,
                    style = MaterialTheme.typography.bodyLarge
                )
                payload.body?.let { body ->
                    Text(
                        text = body,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = MaterialTheme.typography.bodyMedium
                    )
                }
            }

            is FilePayload -> {
                Text(text = payload.file.name, style = MaterialTheme.typography.bodyLarge)
                Text(
                    text = Formatter.formatShortFileSize(LocalContext.current, payload.file.size),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.labelMedium
                )
            }
        }
    }
}

@Composable
internal fun PushPayload.kindLabel(): String = when (this) {
    is NotePayload -> stringResource(R.string.home_note)
    is LinkPayload -> stringResource(R.string.home_link)
    is FilePayload -> stringResource(R.string.home_file)
}

internal fun PushPayload.kindIcon(): ImageVector = when (this) {
    is NotePayload -> Icons.Default.Email
    is LinkPayload -> Icons.Default.Share
    is FilePayload -> Icons.Default.Create
}

internal fun copy(context: Context, text: String) {
    context.getSystemService(ClipboardManager::class.java)
        .setPrimaryClip(ClipData.newPlainText(null, text))
}

internal fun formatTimestamp(value: String): String = runCatching {
    TIMESTAMP_FORMATTER.withLocale(Locale.getDefault()).withZone(ZoneId.systemDefault()).format(Instant.parse(value))
}.getOrDefault(value)

private val TIMESTAMP_FORMATTER: DateTimeFormatter = DateTimeFormatter
    .ofPattern("MMM d · h:mm a", Locale.ROOT)
