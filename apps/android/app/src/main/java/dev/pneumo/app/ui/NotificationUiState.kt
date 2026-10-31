package dev.pneumo.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import dev.pneumo.app.AppContainer
import dev.pneumo.app.R
import dev.pneumo.app.data.AppSession
import dev.pneumo.app.net.ws.ConnectionState
import dev.pneumo.app.ui.devices.DevicesRoute
import dev.pneumo.app.ui.home.HomeRoute
import dev.pneumo.app.ui.home.rememberHomeViewModel
import dev.pneumo.app.ui.screens.ErrorMessage
import dev.pneumo.app.ui.screens.MainShell
import dev.pneumo.app.ui.screens.MainTab
import dev.pneumo.app.ui.screens.ShellUiState
import dev.pneumo.app.ui.settings.SettingsHostState
import dev.pneumo.app.ui.settings.SettingsRoute
import kotlinx.coroutines.CancellationException

data class NotificationUiState(val pushId: String? = null, val navigationId: Long = 0L)

@Composable
internal fun HomeEntry(
    state: PairingState,
    connection: ConnectionState,
    notifications: NotificationUiState,
    container: AppContainer,
    onSignOut: () -> Unit
) {
    var tab by rememberSaveable { mutableStateOf(MainTab.Home) }
    var handledNotificationNavigationId by rememberSaveable { mutableLongStateOf(0L) }
    var attempt by rememberSaveable { mutableIntStateOf(0) }
    val loaded = rememberShellSession(container, state.origin, attempt = attempt)
    LaunchedEffect(notifications.pushId, notifications.navigationId) {
        if (notifications.pushId != null && notifications.navigationId != handledNotificationNavigationId) {
            tab = MainTab.Home
            handledNotificationNavigationId = notifications.navigationId
        }
    }
    val shellState = ShellUiState(
        origin = state.origin,
        busy = state.busy,
        error = state.error,
        connection = connection,
        pushId = notifications.pushId
    )
    MainShell(
        tab = tab,
        state = shellState,
        onTab = { tab = it },
        content = { destination, contentModifier ->
            val currentSession = loaded.session
            when {
                destination == MainTab.Settings -> SettingsRoute(
                    state = SettingsHostState(
                        origin = shellState.origin,
                        connection = shellState.connection,
                        signOutBusy = shellState.busy,
                        signOutError = shellState.error
                    ),
                    onSignOut = onSignOut,
                    modifier = contentModifier.padding(horizontal = 24.dp, vertical = 8.dp)
                )

                currentSession != null && destination == MainTab.Home -> HomeRoute(
                    viewModel = rememberHomeViewModel(currentSession, container.database),
                    connection = shellState.connection,
                    pushId = shellState.pushId,
                    navigationId = notifications.navigationId,
                    modifier = contentModifier
                )

                currentSession != null -> DevicesRoute(
                    session = currentSession,
                    database = container.database,
                    onOpenSettings = { tab = MainTab.Settings },
                    modifier = contentModifier.padding(horizontal = 24.dp, vertical = 8.dp)
                )

                else -> SessionLoading(
                    error = loaded.failed,
                    onRetry = { attempt++ },
                    modifier = contentModifier
                )
            }
        }
    )
}

private data class ShellSessionState(val session: AppSession? = null, val failed: Boolean = false)

@Composable
private fun rememberShellSession(container: AppContainer, origin: String, attempt: Int): ShellSessionState {
    val loaded by produceState(ShellSessionState(), container, origin, attempt) {
        value = ShellSessionState()
        value = try {
            val session = container.openSession()
            ShellSessionState(session, failed = session == null)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            ShellSessionState(failed = true)
        }
    }
    return loaded
}

@Composable
private fun SessionLoading(error: Boolean, onRetry: () -> Unit, modifier: Modifier = Modifier) {
    Column(
        modifier = modifier.padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        if (error) {
            ErrorMessage(stringResource(R.string.shell_session_error))
            TextButton(onClick = onRetry) { Text(stringResource(R.string.shell_retry_session)) }
        } else {
            CircularProgressIndicator()
        }
    }
}
