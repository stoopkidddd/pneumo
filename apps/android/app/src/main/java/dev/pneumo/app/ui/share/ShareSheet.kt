package dev.pneumo.app.ui.share

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.pneumo.app.R
import dev.pneumo.app.transfer.UploadAttachment
import dev.pneumo.app.ui.screens.ErrorMessage
import dev.pneumo.app.ui.screens.PrimaryButton

internal enum class ShareMode {
    Loading,
    NotPaired,
    Invalid,
    LoadError,
    Ready
}

internal data class ShareDevice(val id: String, val name: String, val online: Boolean)

internal data class ShareUiState(
    val mode: ShareMode = ShareMode.Loading,
    val sharedText: SharedText? = null,
    val files: List<UploadAttachment> = emptyList(),
    val isLink: Boolean = false,
    val devices: List<ShareDevice> = emptyList(),
    val selectedTargetId: String? = null,
    val message: String = "",
    val sending: Boolean = false,
    val error: String? = null
)

internal data class ShareActions(
    val onTargetSelect: (String?) -> Unit,
    val onMessageChange: (String) -> Unit,
    val onSend: () -> Unit,
    val onPair: () -> Unit,
    val onRetry: () -> Unit,
    val onDismiss: () -> Unit
) {
    companion object {
        val None = ShareActions({}, {}, {}, {}, {}, {})
    }
}

@Composable
internal fun ShareSheet(state: ShareUiState, actions: ShareActions, modifier: Modifier = Modifier) {
    Surface(
        modifier = modifier.fillMaxWidth().widthIn(max = 560.dp),
        shape = RoundedCornerShape(topStart = 14.dp, topEnd = 14.dp),
        color = MaterialTheme.colorScheme.surface,
        shadowElevation = 8.dp
    ) {
        Column(
            modifier = Modifier
                .navigationBarsPadding()
                .imePadding()
                .heightIn(max = 720.dp)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 24.dp, vertical = 16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            ShareHeader(actions.onDismiss)
            when (state.mode) {
                ShareMode.Loading -> LoadingContent()
                ShareMode.NotPaired -> NotPairedContent(actions.onPair)
                ShareMode.Invalid -> InvalidContent()
                ShareMode.LoadError -> LoadErrorContent(actions.onRetry)
                ShareMode.Ready -> ReadyContent(state, actions)
            }
        }
    }
}

@Composable
private fun ShareHeader(onDismiss: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(
            text = stringResource(R.string.share_activity_label),
            modifier = Modifier.weight(1f),
            style = MaterialTheme.typography.titleMedium
        )
        IconButton(onClick = onDismiss) {
            Icon(Icons.Default.Close, contentDescription = stringResource(R.string.share_close))
        }
    }
}

@Composable
private fun LoadingContent() {
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 24.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        CircularProgressIndicator(modifier = Modifier.size(24.dp), strokeWidth = 2.dp)
        Text(stringResource(R.string.share_loading), style = MaterialTheme.typography.bodyLarge)
    }
}

@Composable
private fun NotPairedContent(onPair: () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(stringResource(R.string.share_pair_title), style = MaterialTheme.typography.headlineMedium)
            Text(
                stringResource(R.string.share_pair_body),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodyLarge
            )
        }
        PrimaryButton(onClick = onPair, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
            Text(stringResource(R.string.share_pair_action))
        }
    }
}

@Composable
private fun InvalidContent() {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(stringResource(R.string.share_invalid_title), style = MaterialTheme.typography.headlineMedium)
        ErrorMessage(stringResource(R.string.share_invalid_body))
    }
}

@Composable
private fun LoadErrorContent(onRetry: () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                stringResource(R.string.share_prepare_error_title),
                style = MaterialTheme.typography.headlineMedium
            )
            ErrorMessage(stringResource(R.string.share_prepare_error_body))
        }
        PrimaryButton(onClick = onRetry, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
            Text(stringResource(R.string.share_retry))
        }
    }
}

@Composable
private fun ReadyContent(state: ShareUiState, actions: ShareActions) {
    Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
        if (state.files.isNotEmpty()) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                state.files.forEach { file ->
                    Text(file.name, style = MaterialTheme.typography.titleSmall)
                }
                HorizontalDivider(color = MaterialTheme.colorScheme.outline)
            }
        } else {
            state.sharedText?.let { SharedTextPreview(it, state.isLink) }
        }
        TargetPicker(
            devices = state.devices,
            selectedTargetId = state.selectedTargetId,
            enabled = !state.sending,
            onTargetSelect = actions.onTargetSelect
        )
        OutlinedTextField(
            value = state.message,
            onValueChange = actions.onMessageChange,
            modifier = Modifier.fillMaxWidth(),
            enabled = !state.sending,
            label = { Text(stringResource(R.string.share_message_label)) },
            supportingText = {
                Text(
                    stringResource(
                        if (state.files.isEmpty()) {
                            R.string.share_message_supporting
                        } else {
                            R.string.share_file_message_supporting
                        }
                    )
                )
            },
            minLines = 2,
            maxLines = 4,
            shape = MaterialTheme.shapes.small
        )
        state.error?.let { ErrorMessage(it) }
        PrimaryButton(
            onClick = actions.onSend,
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
            enabled = !state.sending
        ) {
            if (state.sending) {
                CircularProgressIndicator(
                    modifier = Modifier.size(20.dp),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    strokeWidth = 2.dp
                )
                Spacer(Modifier.size(8.dp))
                Text(stringResource(R.string.share_sending))
            } else {
                Text(stringResource(R.string.share_send))
            }
        }
    }
}

@Composable
private fun SharedTextPreview(sharedText: SharedText, isLink: Boolean) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            text = stringResource(if (isLink) R.string.share_link_label else R.string.share_note_label),
            color = MaterialTheme.colorScheme.primary,
            style = MaterialTheme.typography.labelLarge
        )
        sharedText.title?.takeIf(String::isNotBlank)?.let { title ->
            Text(
                text = title,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                style = MaterialTheme.typography.titleSmall
            )
        }
        Text(
            text = sharedText.body,
            maxLines = 4,
            overflow = TextOverflow.Ellipsis,
            style = MaterialTheme.typography.bodyLarge
        )
        HorizontalDivider(color = MaterialTheme.colorScheme.outline)
    }
}

@Composable
private fun TargetPicker(
    devices: List<ShareDevice>,
    selectedTargetId: String?,
    enabled: Boolean,
    onTargetSelect: (String?) -> Unit
) {
    var expanded by remember { mutableStateOf(false) }
    val selected = devices.firstOrNull { it.id == selectedTargetId }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(stringResource(R.string.share_target_label), style = MaterialTheme.typography.labelLarge)
        Box {
            OutlinedButton(
                onClick = { expanded = true },
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                enabled = enabled,
                shape = MaterialTheme.shapes.small
            ) {
                Text(
                    text = selected?.name ?: stringResource(R.string.share_target_all),
                    modifier = Modifier.weight(1f),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
                Icon(
                    Icons.Default.KeyboardArrowDown,
                    contentDescription = stringResource(R.string.share_target_menu_description)
                )
            }
            DropdownMenu(
                expanded = expanded,
                onDismissRequest = { expanded = false },
                modifier = Modifier.fillMaxWidth(TARGET_MENU_WIDTH_FRACTION)
            ) {
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.share_target_all)) },
                    onClick = {
                        expanded = false
                        onTargetSelect(null)
                    }
                )
                devices.forEach { device ->
                    DropdownMenuItem(
                        text = { DeviceLabel(device) },
                        onClick = {
                            expanded = false
                            onTargetSelect(device.id)
                        }
                    )
                }
            }
        }
    }
}

@Composable
private fun DeviceLabel(device: ShareDevice) {
    Row(
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Box(
            Modifier
                .size(8.dp)
                .clip(CircleShape)
                .background(
                    if (device.online) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outline
                )
        )
        Column {
            Text(device.name, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(
                text = stringResource(
                    if (device.online) R.string.share_device_online else R.string.share_device_offline
                ),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodySmall
            )
        }
    }
}

private const val TARGET_MENU_WIDTH_FRACTION = 0.9f
