package dev.pneumo.app.ui.settings

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import dev.pneumo.app.R
import dev.pneumo.app.ui.screens.ErrorMessage
import dev.pneumo.app.ui.screens.WarningMessage

@Composable
internal fun PermissionsSettingsSection(state: SettingsUiState, actions: SettingsActions) {
    Column(verticalArrangement = Arrangement.spacedBy(24.dp)) {
        SettingsSection(title = stringResource(R.string.settings_permissions_heading)) {
            SettingsValueRow(
                label = stringResource(R.string.settings_notifications_label),
                value = stringResource(
                    if (state.notificationsEnabled) R.string.settings_enabled else R.string.settings_denied
                ),
                emphasized = state.notificationsEnabled
            )
            HorizontalDivider(color = MaterialTheme.colorScheme.outline)
            NotificationSettingsControl(
                notificationsEnabled = state.notificationsEnabled,
                onOpenSettings = actions.onOpenNotificationSettings
            )
            HorizontalDivider(color = MaterialTheme.colorScheme.outline)
            SettingsValueRow(
                label = stringResource(R.string.settings_battery_label),
                value = stringResource(
                    if (state.batteryExempt) {
                        R.string.settings_battery_exempt
                    } else {
                        R.string.settings_battery_optimized
                    }
                ),
                emphasized = state.batteryExempt
            )
            if (!state.batteryExempt) {
                HorizontalDivider(color = MaterialTheme.colorScheme.outline)
                BatterySettingsRecovery(actions.onRequestBatteryExemption)
            }
        }
        if (state.deliveryError != null) ErrorMessage(state.deliveryError)
    }
}

@Composable
internal fun AboutSettingsSection(state: SettingsUiState) {
    SettingsSection(title = stringResource(R.string.settings_about_heading)) {
        SettingsValueRow(
            label = stringResource(R.string.settings_server_label),
            value = state.authority
        )
        HorizontalDivider(color = MaterialTheme.colorScheme.outline)
        SettingsValueRow(
            label = stringResource(R.string.settings_version_label),
            value = state.versionName
        )
    }
}

@Composable
internal fun SignOutSettingsSection(state: SettingsUiState, onSignOut: () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(24.dp)) {
        if (state.signOutError != null) ErrorMessage(state.signOutError)
        OutlinedButton(
            onClick = onSignOut,
            enabled = !state.signOutBusy,
            shape = MaterialTheme.shapes.medium,
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
            border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline),
            colors =
                ButtonDefaults.outlinedButtonColors(
                    containerColor = MaterialTheme.colorScheme.surface,
                    contentColor = MaterialTheme.colorScheme.error,
                    disabledContainerColor = MaterialTheme.colorScheme.surface,
                    disabledContentColor = MaterialTheme.colorScheme.onSurfaceVariant
                )
        ) {
            if (state.signOutBusy) {
                CircularProgressIndicator(
                    modifier = Modifier.size(20.dp),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    strokeWidth = 2.dp
                )
            }
            Text(
                text = stringResource(
                    if (state.signOutBusy) R.string.settings_signing_out else R.string.settings_sign_out
                ),
                modifier = Modifier.padding(start = if (state.signOutBusy) 8.dp else 0.dp)
            )
        }
    }
}

@Composable
private fun SettingsSection(title: String, content: @Composable ColumnScope.() -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(text = title, style = MaterialTheme.typography.titleMedium)
        Surface(
            color = MaterialTheme.colorScheme.surface,
            shape = MaterialTheme.shapes.medium,
            border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline)
        ) {
            Column(content = content)
        }
    }
}

@Composable
private fun SettingsValueRow(label: String, value: String, emphasized: Boolean = false) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(16.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(
            text = label,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.bodyMedium
        )
        Text(
            text = value,
            modifier = Modifier.weight(1f).padding(start = 16.dp),
            color = if (emphasized) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
            style = MaterialTheme.typography.bodyMedium,
            textAlign = TextAlign.End
        )
    }
}

@Composable
private fun NotificationSettingsControl(notificationsEnabled: Boolean, onOpenSettings: () -> Unit) {
    Column(
        modifier = Modifier.padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        if (!notificationsEnabled) {
            WarningMessage(stringResource(R.string.shell_notifications_off))
            Text(
                text = stringResource(R.string.shell_notifications_off_body),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodyMedium
            )
        }
        RecoveryButton(
            label = stringResource(R.string.shell_open_notification_settings),
            onClick = onOpenSettings
        )
    }
}

@Composable
private fun BatterySettingsRecovery(onRequestExemption: () -> Unit) {
    Column(
        modifier = Modifier.padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        WarningMessage(stringResource(R.string.settings_battery_warning))
        RecoveryButton(
            label = stringResource(R.string.settings_request_battery_exemption),
            onClick = onRequestExemption
        )
    }
}

@Composable
private fun RecoveryButton(label: String, onClick: () -> Unit) {
    OutlinedButton(
        onClick = onClick,
        shape = MaterialTheme.shapes.medium,
        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline),
        colors =
            ButtonDefaults.outlinedButtonColors(
                containerColor = MaterialTheme.colorScheme.surface,
                contentColor = MaterialTheme.colorScheme.primary
            )
    ) {
        Text(label)
    }
}
