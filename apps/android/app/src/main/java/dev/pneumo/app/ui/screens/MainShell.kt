package dev.pneumo.app.ui.screens

import androidx.annotation.StringRes
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Phone
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
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
    val pushId: String? = null
)

@Composable
fun MainShell(
    tab: MainTab,
    state: ShellUiState,
    onTab: (MainTab) -> Unit,
    modifier: Modifier = Modifier,
    content: @Composable (MainTab, Modifier) -> Unit
) {
    val authority = remember(state.origin) { originAuthority(state.origin) }
    Scaffold(
        modifier = modifier.fillMaxSize().imePadding(),
        containerColor = MaterialTheme.colorScheme.background,
        bottomBar = { MainNavigation(tab = tab, onTab = onTab) }
    ) { innerPadding ->
        Column(
            modifier =
                Modifier
                    .fillMaxSize()
                    .padding(innerPadding)
                    .consumeWindowInsets(innerPadding)
                    .safeDrawingPadding(),
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            Column(
                modifier = Modifier.fillMaxWidth().padding(start = 24.dp, end = 24.dp, top = 24.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp)
            ) {
                BrandHeader()
                Text(
                    text = stringResource(R.string.shell_connected_to, authority),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.labelMedium
                )
            }
            content(tab, Modifier.fillMaxWidth().weight(1f))
        }
    }
}

@Composable
private fun MainNavigation(tab: MainTab, onTab: (MainTab) -> Unit) {
    NavigationBar(containerColor = MaterialTheme.colorScheme.surface) {
        MainTab.entries.forEach { destination ->
            NavigationBarItem(
                selected = tab == destination,
                onClick = { onTab(destination) },
                icon = {
                    androidx.compose.material3.Icon(
                        imageVector = destination.navigationIcon,
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
