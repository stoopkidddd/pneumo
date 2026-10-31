package dev.pneumo.app.ui.devices

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import dev.pneumo.app.R
import dev.pneumo.app.protocol.Platform
import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

@Composable
internal fun DeviceRow(state: DeviceRowState, actions: DevicesActions) {
    Column(
        modifier = Modifier.fillMaxWidth().padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        DeviceSummary(state.device, state.now)
        when {
            state.editing -> RenameDeviceForm(state.device, state.renameDraft, state.busy, actions)
            state.confirmingRemoval -> RemoveDeviceConfirmation(state.device, state.busy, actions)
            else -> DeviceRowActions(state.device, state.controlsEnabled, actions)
        }
    }
}

@Composable
private fun DeviceSummary(device: DeviceUiModel, now: Instant) {
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.Top) {
        Icon(
            painter = painterResource(device.platform.iconResource),
            contentDescription = stringResource(device.platform.label),
            tint = MaterialTheme.colorScheme.primary,
            modifier = Modifier.size(24.dp)
        )
        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            DeviceName(device)
            Text(
                text = stringResource(device.platform.label),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.labelMedium
            )
            DeviceOnlineStatus(device.online)
            Text(
                text = lastSeenText(device.lastSeenAt, now),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodySmall
            )
        }
    }
}

@Composable
private fun DeviceName(device: DeviceUiModel) {
    Row(
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(text = device.name, style = MaterialTheme.typography.bodyLarge)
        if (device.isOwn) {
            Text(
                text = stringResource(R.string.devices_this_device),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.labelMedium
            )
        }
    }
}

@Composable
private fun DeviceOnlineStatus(online: Boolean) {
    Row(
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Box(
            Modifier
                .size(8.dp)
                .background(
                    if (online) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                    CircleShape
                )
        )
        Text(
            text = stringResource(if (online) R.string.devices_online else R.string.devices_offline),
            color = if (online) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.labelMedium
        )
    }
}

@Composable
private fun RenameDeviceForm(device: DeviceUiModel, draft: String, busy: Boolean, actions: DevicesActions) {
    val focusRequester = remember { FocusRequester() }
    LaunchedEffect(device.id) { focusRequester.requestFocus() }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedTextField(
            value = draft,
            onValueChange = actions.onRenameChange,
            enabled = !busy,
            singleLine = true,
            label = { Text(stringResource(R.string.devices_name_label)) },
            keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(imeAction = ImeAction.Done),
            keyboardActions = androidx.compose.foundation.text.KeyboardActions(onDone = { actions.onSaveRename() }),
            modifier = Modifier.fillMaxWidth().focusRequester(focusRequester),
            shape = MaterialTheme.shapes.small
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(
                onClick = actions.onSaveRename,
                enabled = !busy && draft.trim().isNotEmpty() && draft.trim() != device.name,
                modifier = Modifier.heightIn(min = 48.dp),
                shape = MaterialTheme.shapes.medium
            ) {
                if (busy) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(18.dp),
                        color = MaterialTheme.colorScheme.onPrimary,
                        strokeWidth = 2.dp
                    )
                }
                Text(
                    text = stringResource(if (busy) R.string.devices_saving_name else R.string.devices_save_name),
                    modifier = Modifier.padding(start = if (busy) 8.dp else 0.dp)
                )
            }
            OutlinedButton(
                onClick = actions.onCancelRename,
                enabled = !busy,
                modifier = Modifier.heightIn(min = 48.dp),
                shape = MaterialTheme.shapes.medium,
                border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline)
            ) {
                Text(stringResource(R.string.devices_cancel))
            }
        }
    }
}

@Composable
private fun RemoveDeviceConfirmation(device: DeviceUiModel, busy: Boolean, actions: DevicesActions) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            text = stringResource(R.string.devices_remove_confirmation, device.name),
            style = MaterialTheme.typography.bodyMedium
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(
                onClick = actions.onConfirmRemove,
                enabled = !busy,
                modifier = Modifier.heightIn(min = 48.dp),
                shape = MaterialTheme.shapes.medium,
                border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline),
                colors =
                    ButtonDefaults.outlinedButtonColors(
                        containerColor = MaterialTheme.colorScheme.surface,
                        contentColor = MaterialTheme.colorScheme.error,
                        disabledContainerColor = MaterialTheme.colorScheme.surface,
                        disabledContentColor = MaterialTheme.colorScheme.onSurfaceVariant
                    )
            ) {
                if (busy) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(18.dp),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        strokeWidth = 2.dp
                    )
                }
                Text(
                    text = stringResource(if (busy) R.string.devices_removing else R.string.devices_remove_device),
                    modifier = Modifier.padding(start = if (busy) 8.dp else 0.dp)
                )
            }
            TextButton(
                onClick = actions.onCancelRemove,
                enabled = !busy,
                modifier = Modifier.heightIn(min = 48.dp)
            ) {
                Text(stringResource(R.string.devices_cancel))
            }
        }
    }
}

@Composable
private fun DeviceRowActions(device: DeviceUiModel, enabled: Boolean, actions: DevicesActions) {
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        TextButton(
            onClick = { actions.onBeginRename(device.id) },
            enabled = enabled,
            modifier = Modifier.heightIn(min = 48.dp)
        ) {
            Text(stringResource(R.string.devices_rename))
        }
        TextButton(
            onClick = { actions.onRequestRemove(device.id) },
            enabled = enabled,
            modifier = Modifier.heightIn(min = 48.dp),
            colors =
                ButtonDefaults.textButtonColors(
                    contentColor = if (device.isOwn) {
                        MaterialTheme.colorScheme.primary
                    } else {
                        MaterialTheme.colorScheme.error
                    }
                )
        ) {
            Text(
                stringResource(
                    if (device.isOwn) R.string.devices_open_sign_out else R.string.devices_remove
                )
            )
        }
    }
}

@Composable
private fun lastSeenText(timestamp: String, now: Instant): String {
    val lastSeen = runCatching { Instant.parse(timestamp) }.getOrNull()
        ?: return stringResource(R.string.devices_last_seen_now)
    val elapsed = Duration.between(lastSeen, now).coerceAtLeast(Duration.ZERO)
    val minutes = elapsed.toMinutes()
    return when {
        minutes < MINUTES_PER_HOUR -> {
            if (minutes < 1) {
                stringResource(R.string.devices_last_seen_now)
            } else {
                pluralStringResource(R.plurals.devices_last_seen_minutes, minutes.toInt(), minutes)
            }
        }

        minutes < MINUTES_PER_DAY -> {
            val hours = elapsed.toHours()
            pluralStringResource(R.plurals.devices_last_seen_hours, hours.toInt(), hours)
        }

        minutes < MINUTES_PER_WEEK -> {
            val days = elapsed.toDays()
            pluralStringResource(R.plurals.devices_last_seen_days, days.toInt(), days)
        }

        else -> stringResource(
            R.string.devices_last_seen_date,
            rememberLastSeenDate(timestamp, lastSeen)
        )
    }
}

@Composable
private fun rememberLastSeenDate(timestamp: String, lastSeen: Instant): String = remember(timestamp) {
    DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM)
        .withZone(ZoneId.systemDefault())
        .format(lastSeen)
}

private val Platform.iconResource: Int
    get() = when (this) {
        Platform.ANDROID -> R.drawable.ic_platform_android
        Platform.WEB -> R.drawable.ic_platform_web
        Platform.DESKTOP -> R.drawable.ic_platform_desktop
        Platform.CLI -> R.drawable.ic_platform_cli
    }

private val Platform.label: Int
    get() = when (this) {
        Platform.ANDROID -> R.string.devices_platform_android
        Platform.WEB -> R.string.devices_platform_web
        Platform.DESKTOP -> R.string.devices_platform_desktop
        Platform.CLI -> R.string.devices_platform_cli
    }

private const val MINUTES_PER_HOUR = 60L
private const val MINUTES_PER_DAY = 24L * MINUTES_PER_HOUR
private const val MINUTES_PER_WEEK = 7L * MINUTES_PER_DAY
