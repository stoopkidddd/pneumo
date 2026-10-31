package dev.pneumo.app.ui.screens

import android.content.Intent
import android.provider.Settings as AndroidSettings
import androidx.annotation.StringRes
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Phone
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import dev.pneumo.app.R
import dev.pneumo.app.net.ws.ConnectionState

enum class MainTab {
    Home,
    Devices,
    Settings
}

data class ShellUiState(
    val origin: String,
    val busy: Boolean,
    val error: String?,
    val connection: ConnectionState,
    val notificationsEnabled: Boolean = true,
    val pushId: String? = null
)

@Composable
fun MainShell(
    tab: MainTab,
    state: ShellUiState,
    onTab: (MainTab) -> Unit,
    onSignOut: () -> Unit,
    modifier: Modifier = Modifier
) {
    val authority = remember(state.origin) { originAuthority(state.origin) }
    Scaffold(
        modifier = modifier.fillMaxSize(),
        containerColor = MaterialTheme.colorScheme.background,
        bottomBar = { MainNavigation(tab = tab, onTab = onTab) }
    ) { innerPadding ->
        Column(
            modifier =
                Modifier
                    .fillMaxSize()
                    .padding(innerPadding)
                    .consumeWindowInsets(innerPadding)
                    .safeDrawingPadding()
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 24.dp, vertical = 24.dp),
            verticalArrangement = Arrangement.spacedBy(24.dp)
        ) {
            BrandHeader()
            Text(
                text = stringResource(R.string.shell_connected_to, authority),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.labelMedium
            )
            when (tab) {
                MainTab.Home ->
                    EmptyTab(
                        title = stringResource(R.string.shell_home_empty_title),
                        body = stringResource(R.string.shell_home_empty_body)
                    )

                MainTab.Devices ->
                    EmptyTab(
                        title = stringResource(R.string.shell_devices_empty_title),
                        body = stringResource(R.string.shell_devices_empty_body)
                    )

                MainTab.Settings ->
                    SettingsTab(
                        authority = authority,
                        state = state,
                        onSignOut = onSignOut
                    )
            }
        }
    }
}

@Composable
private fun MainNavigation(tab: MainTab, onTab: (MainTab) -> Unit) {
    NavigationBar(containerColor = MaterialTheme.colorScheme.surface) {
        MainTab.entries.forEach { destination ->
            val icon = destination.navigationIcon
            NavigationBarItem(
                selected = tab == destination,
                onClick = { onTab(destination) },
                icon = {
                    androidx.compose.material3.Icon(
                        imageVector = icon,
                        contentDescription = stringResource(destination.label)
                    )
                },
                label = { Text(stringResource(destination.label)) },
                colors =
                    NavigationBarItemDefaults.colors(
                        selectedIconColor = MaterialTheme.colorScheme.primary,
                        selectedTextColor = MaterialTheme.colorScheme.primary,
                        indicatorColor = MaterialTheme.colorScheme.surface,
                        unselectedIconColor = MaterialTheme.colorScheme.onSurfaceVariant,
                        unselectedTextColor = MaterialTheme.colorScheme.onSurfaceVariant
                    )
            )
        }
    }
}

@Composable
private fun EmptyTab(title: String, body: String) {
    Column(
        modifier = Modifier.fillMaxWidth().padding(top = 24.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        Text(text = title, style = MaterialTheme.typography.headlineMedium)
        Text(
            text = body,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.bodyLarge
        )
    }
}

@Composable
private fun SettingsTab(authority: String, state: ShellUiState, onSignOut: () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(24.dp)) {
        Text(text = stringResource(R.string.shell_settings), style = MaterialTheme.typography.headlineMedium)
        ConnectionStatus(state.connection)
        if (!state.notificationsEnabled) {
            NotificationSettingsRecovery()
        }
        Surface(
            color = MaterialTheme.colorScheme.surface,
            shape = MaterialTheme.shapes.medium,
            border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline)
        ) {
            Column(
                modifier = Modifier.fillMaxWidth().padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp)
            ) {
                Text(
                    text = stringResource(R.string.shell_server_label),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.labelMedium
                )
                Text(text = authority, style = MaterialTheme.typography.bodyLarge)
            }
        }
        if (state.error != null) {
            ErrorMessage(state.error)
        }
        OutlinedButton(
            onClick = onSignOut,
            enabled = !state.busy,
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
            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                if (state.busy) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(20.dp),
                        color = LocalContentColor.current,
                        strokeWidth = 2.dp
                    )
                }
                Text(stringResource(R.string.shell_sign_out))
            }
        }
    }
}

@Composable
private fun NotificationSettingsRecovery() {
    val context = LocalContext.current
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        WarningMessage(stringResource(R.string.shell_notifications_off))
        Text(
            text = stringResource(R.string.shell_notifications_off_body),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.bodyMedium
        )
        OutlinedButton(
            onClick = {
                context.startActivity(
                    Intent(AndroidSettings.ACTION_APP_NOTIFICATION_SETTINGS)
                        .putExtra(AndroidSettings.EXTRA_APP_PACKAGE, context.packageName)
                )
            },
            shape = MaterialTheme.shapes.medium,
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
            border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline),
            colors =
                ButtonDefaults.outlinedButtonColors(
                    containerColor = MaterialTheme.colorScheme.surface,
                    contentColor = MaterialTheme.colorScheme.primary
                )
        ) {
            Text(stringResource(R.string.shell_open_notification_settings))
        }
    }
}

private val MainTab.navigationIcon: ImageVector
    get() = when (this) {
        MainTab.Home -> Icons.Default.Home
        MainTab.Devices -> Icons.Default.Phone
        MainTab.Settings -> Icons.Default.Settings
    }

private val MainTab.label: Int
    @StringRes get() = when (this) {
        MainTab.Home -> R.string.shell_home
        MainTab.Devices -> R.string.shell_devices
        MainTab.Settings -> R.string.shell_settings
    }
