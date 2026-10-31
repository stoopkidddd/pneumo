package dev.pneumo.app.ui.home

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel as composeViewModel
import dev.pneumo.app.data.AppSession
import dev.pneumo.app.data.db.PneumoDatabase
import dev.pneumo.app.net.ws.ConnectionState

@Composable
internal fun rememberHomeViewModel(
    session: AppSession,
    database: PneumoDatabase,
    viewModel: HomeViewModel = composeViewModel(
        key = "home-${session.deviceId}",
        factory = rememberHomeViewModelFactory(session, database)
    )
): HomeViewModel = viewModel

@Composable
private fun rememberHomeViewModelFactory(session: AppSession, database: PneumoDatabase): HomeViewModelFactory =
    remember(session, database) {
        HomeViewModelFactory(
            source = RoomHomeDataSource(session, database),
            contentKey = session.contentKey,
            maxEnvelopeBytes = session.maxEnvelopeBytes
        )
    }

@Composable
internal fun HomeRoute(
    viewModel: HomeViewModel,
    connection: ConnectionState,
    pushId: String?,
    modifier: Modifier = Modifier,
    navigationId: Long = 0L
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    LaunchedEffect(pushId, navigationId) {
        pushId?.let { selected -> viewModel.selectPush(selected, navigationId) }
    }

    HomeScreen(
        state = state,
        connection = connection,
        actions = HomeActions(
            onRetry = viewModel::retry,
            onLoadOlder = viewModel::loadOlder,
            onTextChange = viewModel::updateComposerText,
            onTargetSelect = viewModel::selectTarget,
            onSend = viewModel::send,
            onDelete = viewModel::delete,
            onUndoDelete = viewModel::undoDelete
        ),
        modifier = modifier
    )
}
