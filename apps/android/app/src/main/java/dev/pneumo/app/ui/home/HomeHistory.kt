package dev.pneumo.app.ui.home

import android.content.Intent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.net.toUri
import dev.pneumo.app.R
import dev.pneumo.app.protocol.DeviceDTO
import dev.pneumo.app.protocol.FilePayload
import dev.pneumo.app.protocol.LinkPayload
import dev.pneumo.app.protocol.NotePayload
import dev.pneumo.app.protocol.PushPayload
import dev.pneumo.app.sync.DecryptedPush
import dev.pneumo.app.transfer.DownloadState
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@Composable
internal fun HomeHistoryRow(
    item: DecryptedPush,
    devices: List<DeviceDTO>,
    highlighted: Boolean,
    onDelete: () -> Unit,
    transfer: DownloadState? = null
) {
    val payload = item.payload
    val kind = payload.kindLabel()
    Column {
        Surface(color = MaterialTheme.colorScheme.surface) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(start = 16.dp, end = 8.dp, top = 16.dp, bottom = 12.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalAlignment = Alignment.Top
            ) {
                Icon(
                    imageVector = payload.kindIcon(),
                    contentDescription = kind,
                    modifier = Modifier.padding(top = 2.dp).size(20.dp),
                    tint = if (highlighted) {
                        MaterialTheme.colorScheme.primary
                    } else {
                        MaterialTheme.colorScheme.onSurfaceVariant
                    }
                )
                HomeHistoryBody(
                    item = item,
                    devices = devices,
                    highlighted = highlighted,
                    onDelete = onDelete,
                    transfer = transfer
                )
            }
        }
        HorizontalDivider(color = MaterialTheme.colorScheme.outline)
    }
}

@Composable
private fun RowScope.HomeHistoryBody(
    item: DecryptedPush,
    devices: List<DeviceDTO>,
    highlighted: Boolean,
    onDelete: () -> Unit,
    transfer: DownloadState?
) {
    val source = devices.firstOrNull { device -> device.id == item.push.sourceDeviceId }?.name
        ?: stringResource(R.string.home_removed_device)
    Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        HomeHistoryHeader(
            kind = item.payload.kindLabel(),
            source = source,
            createdAt = item.push.createdAt
        )
        if (highlighted) {
            Text(
                text = stringResource(R.string.home_selected_push),
                color = MaterialTheme.colorScheme.primary,
                style = MaterialTheme.typography.labelSmall
            )
        }
        PushContents(item.payload)
        HomeHistoryActions(item = item, transfer = transfer, onDelete = onDelete)
    }
}

@Composable
private fun HomeHistoryHeader(kind: String, source: String, createdAt: String) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(text = kind, style = MaterialTheme.typography.labelMedium)
        Text(
            text = source,
            modifier = Modifier.weight(1f),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            style = MaterialTheme.typography.labelSmall
        )
        Text(
            text = formatTimestamp(createdAt),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.labelSmall
        )
    }
}

@Composable
private fun HomeHistoryActions(item: DecryptedPush, transfer: DownloadState?, onDelete: () -> Unit) {
    val payload = item.payload
    val context = LocalContext.current
    Column {
        if (payload is FilePayload) {
            HomeFileTransfer(pushId = item.push.id, mime = payload.file.mime, state = transfer)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            when (payload) {
                is NotePayload -> HomeCopyButton(payload.body)

                is LinkPayload -> {
                    HomeCopyButton(payload.url)
                    TextButton(onClick = {
                        context.startActivity(Intent(Intent.ACTION_VIEW, payload.url.toUri()))
                    }) {
                        Text(stringResource(R.string.home_open))
                    }
                }

                is FilePayload -> Unit
            }
            TextButton(
                onClick = onDelete,
                colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error)
            ) {
                Icon(
                    imageVector = Icons.Default.Delete,
                    contentDescription = null,
                    modifier = Modifier.size(18.dp)
                )
                Spacer(Modifier.size(6.dp))
                Text(stringResource(R.string.home_delete))
            }
        }
    }
}

@Composable
private fun HomeCopyButton(text: String) {
    val context = LocalContext.current
    var copied by remember(text) { mutableStateOf(false) }
    val copyScope = rememberCoroutineScope()
    TextButton(onClick = {
        copy(context, text)
        copied = true
        copyScope.launch {
            delay(COPY_FEEDBACK_MILLIS)
            copied = false
        }
    }) {
        Text(stringResource(if (copied) R.string.home_copied else R.string.home_copy))
    }
}

private const val COPY_FEEDBACK_MILLIS = 2_000L
