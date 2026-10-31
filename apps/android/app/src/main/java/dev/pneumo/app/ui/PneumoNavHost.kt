package dev.pneumo.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import dev.pneumo.app.BuildConfig
import dev.pneumo.app.net.ws.ConnectionState
import dev.pneumo.app.ui.screens.ConfirmScreen
import dev.pneumo.app.ui.screens.ConfirmUiState
import kotlinx.coroutines.flow.StateFlow

@Composable
fun PneumoNavHost(
    viewModel: PairingViewModel,
    connectionState: StateFlow<ConnectionState>,
    modifier: Modifier = Modifier,
    notifications: NotificationUiState = NotificationUiState()
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val connection by connectionState.collectAsStateWithLifecycle()
    val controller = rememberNavController()
    // Only public route names enter navigation saved state; pairing data stays in the ViewModel.
    LaunchedEffect(state.destination) {
        if (controller.currentBackStackEntry?.destination?.route == state.destination.name) return@LaunchedEffect
        controller.navigate(state.destination.name) {
            popUpTo(controller.graph.id) { inclusive = true }
            launchSingleTop = true
        }
    }
    Surface(modifier = modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        NavHost(navController = controller, startDestination = AppDestination.Loading.name) {
            composable(AppDestination.Loading.name) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
            }
            composable(AppDestination.Pair.name) {
                PairEntry(
                    error = state.error,
                    onOpenLink = viewModel::openLink
                )
            }
            composable(AppDestination.Confirm.name) {
                BackHandler(enabled = !state.busy) { viewModel.backToPair() }
                BackHandler(enabled = state.busy) { /* Keep an in-flight claim attached to its owner. */ }
                ConfirmScreen(
                    state = ConfirmUiState(
                        origin = state.origin,
                        busy = state.busy,
                        error = state.error,
                        retryable = state.retryable,
                        showInsecureWarning = !BuildConfig.DEBUG && !state.origin.startsWith("https://")
                    ),
                    onConfirm = viewModel::confirm,
                    onBack = viewModel::backToPair
                )
            }
            composable(AppDestination.Onboarding.name) {
                PermissionOnboarding(
                    onDone = viewModel::completeOnboarding,
                    error = state.error
                )
            }
            composable(AppDestination.Home.name) {
                HomeEntry(
                    state = state,
                    connection = connection,
                    notifications = notifications,
                    onSignOut = viewModel::signOut
                )
            }
        }
    }
}
