package dev.pneumo.app.ui.home

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.pneumo.app.R
import dev.pneumo.app.data.TextPushes
import dev.pneumo.app.protocol.DeviceDTO
import dev.pneumo.app.protocol.LinkPayload
import dev.pneumo.app.ui.screens.PrimaryButton

@Composable
internal fun HomeComposer(
    state: HomeComposerState,
    devices: List<DeviceDTO>,
    offline: Boolean,
    actions: HomeComposerActions
) {
    val isLink = remember(state.text) {
        state.text.isNotBlank() && TextPushes.payload(state.text) is LinkPayload
    }
    Surface(color = MaterialTheme.colorScheme.surface) {
        Column {
            HorizontalDivider(color = MaterialTheme.colorScheme.outline)
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp, vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                ComposerMessageField(state, actions.onTextChange)
                if (isLink && state.attachments.isEmpty()) LinkDetected()
                ComposerAttachments(state, actions)
                state.uploadProgress?.let { progress ->
                    Text(stringResource(R.string.transfer_uploading), style = MaterialTheme.typography.labelMedium)
                    LinearProgressIndicator(
                        progress = { progress / 100f },
                        modifier = Modifier.fillMaxWidth()
                    )
                }
                state.uploadError?.let { message ->
                    Text(message, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
                }
                ComposerControls(
                    state = state,
                    devices = devices,
                    offline = offline,
                    actions = actions
                )
                state.error?.let { message ->
                    Text(
                        text = message,
                        modifier = Modifier.semantics { liveRegion = LiveRegionMode.Assertive },
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodyMedium
                    )
                }
            }
        }
    }
}

@Composable
private fun ComposerMessageField(state: HomeComposerState, onTextChange: (String) -> Unit) {
    OutlinedTextField(
        value = state.text,
        onValueChange = onTextChange,
        modifier = Modifier.fillMaxWidth().heightIn(min = 88.dp),
        enabled = !state.sending,
        label = { Text(stringResource(R.string.home_composer_message)) },
        placeholder = { Text(stringResource(R.string.home_composer_placeholder)) },
        minLines = 2,
        maxLines = 4,
        shape = MaterialTheme.shapes.small
    )
}

@Composable
private fun ComposerAttachments(state: HomeComposerState, actions: HomeComposerActions) {
    if (state.preparingAttachments) {
        Text(stringResource(R.string.transfer_preparing), style = MaterialTheme.typography.bodyMedium)
    } else if (state.attachments.isNotEmpty()) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                state.attachments.joinToString { it.name },
                modifier = Modifier.weight(1f),
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                style = MaterialTheme.typography.bodyMedium
            )
            TextButton(onClick = actions.onRemoveAttachments, enabled = !state.sending) {
                Text(stringResource(R.string.transfer_remove))
            }
        }
    }
}

@Composable
private fun LinkDetected() {
    Row(
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Icon(
            imageVector = Icons.Default.Share,
            contentDescription = null,
            modifier = Modifier.size(18.dp),
            tint = MaterialTheme.colorScheme.primary
        )
        Text(
            text = stringResource(R.string.home_link_detected),
            color = MaterialTheme.colorScheme.primary,
            style = MaterialTheme.typography.labelMedium
        )
    }
}

@Composable
private fun ComposerControls(
    state: HomeComposerState,
    devices: List<DeviceDTO>,
    offline: Boolean,
    actions: HomeComposerActions
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        IconButton(onClick = actions.onAttach, enabled = !state.sending && !state.preparingAttachments) {
            Icon(Icons.Default.Add, contentDescription = stringResource(R.string.transfer_attach))
        }
        TargetPicker(
            devices = devices,
            selectedId = state.targetDeviceId,
            enabled = !state.sending,
            onTargetSelect = actions.onTargetSelect,
            modifier = Modifier.weight(1f)
        )
        ComposerSendButton(
            sending = state.sending,
            enabled = state.canSend && (!offline || state.attachments.isNotEmpty()),
            onSend = actions.onSend
        )
    }
}

@Composable
private fun ComposerSendButton(sending: Boolean, enabled: Boolean, onSend: () -> Unit) {
    PrimaryButton(
        onClick = onSend,
        enabled = enabled,
        modifier = Modifier.heightIn(min = 48.dp)
    ) {
        if (sending) {
            CircularProgressIndicator(
                modifier = Modifier.size(18.dp),
                color = LocalContentColor.current,
                strokeWidth = 2.dp
            )
        } else {
            Icon(
                imageVector = Icons.AutoMirrored.Filled.Send,
                contentDescription = null,
                modifier = Modifier.size(18.dp)
            )
        }
        Spacer(Modifier.size(8.dp))
        Text(stringResource(if (sending) R.string.home_sending else R.string.home_send))
    }
}

@Composable
private fun TargetPicker(
    devices: List<DeviceDTO>,
    selectedId: String?,
    enabled: Boolean,
    onTargetSelect: (String?) -> Unit,
    modifier: Modifier = Modifier
) {
    var expanded by remember { mutableStateOf(false) }
    val selected = devices.firstOrNull { device -> device.id == selectedId }
    Box(modifier = modifier) {
        OutlinedButton(
            onClick = { expanded = true },
            enabled = enabled,
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
            shape = MaterialTheme.shapes.medium,
            contentPadding = PaddingValues(horizontal = 12.dp)
        ) {
            Column(modifier = Modifier.weight(1f), horizontalAlignment = Alignment.Start) {
                Text(
                    text = stringResource(R.string.home_target_label),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.labelSmall
                )
                Text(
                    text = selected?.name ?: stringResource(R.string.home_target_all),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    style = MaterialTheme.typography.labelMedium
                )
            }
            Icon(imageVector = Icons.Default.ArrowDropDown, contentDescription = null)
        }
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            DropdownMenuItem(
                text = { Text(stringResource(R.string.home_target_all)) },
                onClick = {
                    expanded = false
                    onTargetSelect(null)
                }
            )
            devices.forEach { device ->
                DropdownMenuItem(
                    text = { DeviceTargetLabel(device) },
                    onClick = {
                        expanded = false
                        onTargetSelect(device.id)
                    }
                )
            }
        }
    }
}

@Composable
private fun DeviceTargetLabel(device: DeviceDTO) {
    Row(
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        val dotColor = if (device.online) {
            MaterialTheme.colorScheme.primary
        } else {
            MaterialTheme.colorScheme.onSurfaceVariant
        }
        Canvas(modifier = Modifier.size(8.dp)) { drawCircle(color = dotColor) }
        Column {
            Text(text = device.name, style = MaterialTheme.typography.bodyMedium)
            Text(
                text = stringResource(
                    if (device.online) R.string.home_device_online else R.string.home_device_offline
                ),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.labelSmall
            )
        }
    }
}
