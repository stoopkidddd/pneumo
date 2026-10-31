package dev.pneumo.app.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import dev.pneumo.app.net.ws.ConnectionState
import dev.pneumo.app.ui.screens.MainShell
import dev.pneumo.app.ui.screens.MainTab
import dev.pneumo.app.ui.screens.ShellUiState

data class NotificationUiState(val pushId: String? = null, val navigationId: Long = 0L, val enabled: Boolean = true)

@Composable
internal fun HomeEntry(
    state: PairingState,
    connection: ConnectionState,
    notifications: NotificationUiState,
    onSignOut: () -> Unit
) {
    var tab by rememberSaveable { mutableStateOf(MainTab.Home) }
    var handledNotificationNavigationId by rememberSaveable { mutableLongStateOf(0L) }
    LaunchedEffect(notifications.pushId, notifications.navigationId) {
        if (notifications.pushId != null && notifications.navigationId != handledNotificationNavigationId) {
            tab = MainTab.Home
            handledNotificationNavigationId = notifications.navigationId
        }
    }
    MainShell(
        tab = tab,
        state = ShellUiState(
            origin = state.origin,
            busy = state.busy,
            error = state.error,
            connection = connection,
            notificationsEnabled = notifications.enabled,
            pushId = notifications.pushId
        ),
        onTab = { tab = it },
        onSignOut = onSignOut
    )
}
