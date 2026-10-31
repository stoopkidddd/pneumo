package dev.pneumo.app.ui.home

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import dev.pneumo.app.R
import dev.pneumo.app.net.ws.ConnectionState
import dev.pneumo.app.sync.DecryptedPush

@Composable
internal fun HomeScreen(
    state: HomeUiState,
    connection: ConnectionState,
    actions: HomeActions,
    modifier: Modifier = Modifier
) {
    val snackbarHost = remember { SnackbarHostState() }
    val listState = rememberLazyListState()
    val pushes = state.visiblePushes
    val offline = connection == ConnectionState.Offline
    HomeUndoEffect(state.undoPushId, snackbarHost, actions.onUndoDelete)
    HomeHighlightEffect(state, pushes, listState)

    Scaffold(
        modifier = modifier.fillMaxSize(),
        containerColor = MaterialTheme.colorScheme.background,
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        snackbarHost = { SnackbarHost(snackbarHost) },
        bottomBar = {
            HomeComposer(
                state = state.composer,
                devices = state.devices,
                offline = offline,
                actions = HomeComposerActions(
                    onTextChange = actions.onTextChange,
                    onTargetSelect = actions.onTargetSelect,
                    onSend = actions.onSend,
                    onAttach = actions.onAttach,
                    onRemoveAttachments = actions.onRemoveAttachments
                )
            )
        }
    ) { innerPadding ->
        Box(modifier = Modifier.fillMaxSize().padding(innerPadding)) {
            HomeContent(
                state = state,
                pushes = pushes,
                offline = offline,
                listState = listState,
                actions = actions
            )
        }
    }
}

@Composable
private fun HomeUndoEffect(deletedId: String?, snackbarHost: SnackbarHostState, onUndoDelete: (String) -> Unit) {
    val deletedMessage = stringResource(R.string.home_deleted)
    val undoLabel = stringResource(R.string.home_undo)
    val onUndo by rememberUpdatedState(onUndoDelete)
    LaunchedEffect(deletedId) {
        val pushId = deletedId ?: return@LaunchedEffect
        val result = snackbarHost.showSnackbar(
            message = deletedMessage,
            actionLabel = undoLabel,
            duration = SnackbarDuration.Indefinite
        )
        if (result == androidx.compose.material3.SnackbarResult.ActionPerformed) {
            onUndo(pushId)
        }
    }
}

@Composable
private fun HomeHighlightEffect(state: HomeUiState, pushes: List<DecryptedPush>, listState: LazyListState) {
    val scrollRequests = rememberSaveable(saver = HomeScrollRequestConsumer.Saver) { HomeScrollRequestConsumer() }
    val targetAvailable = pushes.any { item -> item.push.id == state.highlightedPushId }
    LaunchedEffect(state.highlightRequestId, state.highlightedPushId, targetAvailable) {
        val index = scrollRequests.consume(
            navigationId = state.highlightRequestId,
            targetPushId = state.highlightedPushId,
            pushes = pushes
        )
        if (index != null) listState.animateScrollToItem(index)
    }
}

@Composable
private fun HomeContent(
    state: HomeUiState,
    pushes: List<DecryptedPush>,
    offline: Boolean,
    listState: LazyListState,
    actions: HomeActions
) {
    Column(modifier = Modifier.fillMaxSize()) {
        HomeHeading(loading = state.loading, offline = offline)
        if (state.error != null && pushes.isNotEmpty()) {
            HomeError(message = state.error, onRetry = actions.onRetry)
        }
        when {
            state.loading && pushes.isEmpty() -> HomeLoading(modifier = Modifier.weight(1f))

            pushes.isEmpty() -> HomeEmpty(
                error = state.error,
                onRetry = actions.onRetry,
                modifier = Modifier.weight(1f)
            )

            else -> LazyColumn(
                state = listState,
                modifier = Modifier.weight(1f).fillMaxWidth(),
                contentPadding = PaddingValues(bottom = 8.dp)
            ) {
                items(pushes, key = { item -> item.push.id }) { item ->
                    HomeHistoryRow(
                        item = item,
                        devices = state.devices,
                        highlighted = item.push.id == state.highlightedPushId,
                        onDelete = { actions.onDelete(item.push.id) },
                        transfer = state.downloads[item.push.id]
                    )
                }
                if (state.nextBefore != null) {
                    item(key = "home-more") {
                        LoadOlderRow(
                            loading = state.loadingMore,
                            onClick = actions.onLoadOlder
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun HomeHeading(loading: Boolean, offline: Boolean) {
    Column {
        Column(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 16.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp)
        ) {
            Text(
                text = stringResource(R.string.home_title),
                style = MaterialTheme.typography.headlineMedium
            )
            if (offline) {
                Text(
                    text = stringResource(R.string.home_offline),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.labelSmall
                )
            }
        }
        if (loading) {
            LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
        } else {
            HorizontalDivider(color = MaterialTheme.colorScheme.outline)
        }
    }
}

@Composable
private fun HomeLoading(modifier: Modifier = Modifier) {
    Box(modifier = modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            CircularProgressIndicator(modifier = Modifier.size(28.dp), strokeWidth = 2.dp)
            Text(
                text = stringResource(R.string.home_loading),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodyMedium
            )
        }
    }
}

@Composable
private fun HomeEmpty(error: String?, onRetry: () -> Unit, modifier: Modifier = Modifier) {
    Column(
        modifier = modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 32.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Text(
            text = stringResource(R.string.home_empty_title),
            style = MaterialTheme.typography.headlineMedium
        )
        Text(
            text = stringResource(R.string.home_empty_body),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.bodyLarge
        )
        if (error != null) HomeError(message = error, onRetry = onRetry, inset = false)
    }
}

@Composable
private fun HomeError(message: String, onRetry: () -> Unit, inset: Boolean = true) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = if (inset) 24.dp else 0.dp, vertical = 12.dp)
            .semantics { liveRegion = LiveRegionMode.Polite },
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(
            text = message,
            modifier = Modifier.weight(1f),
            color = MaterialTheme.colorScheme.error,
            style = MaterialTheme.typography.bodyMedium
        )
        TextButton(onClick = onRetry) { Text(stringResource(R.string.home_retry)) }
    }
}

@Composable
private fun LoadOlderRow(loading: Boolean, onClick: () -> Unit) {
    Box(
        modifier = Modifier.fillMaxWidth().padding(16.dp),
        contentAlignment = Alignment.Center
    ) {
        OutlinedButton(
            onClick = onClick,
            enabled = !loading,
            modifier = Modifier.heightIn(min = 48.dp),
            shape = MaterialTheme.shapes.medium,
            border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline)
        ) {
            if (loading) {
                CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
                Spacer(Modifier.size(8.dp))
            }
            Text(
                stringResource(
                    if (loading) R.string.home_loading_older else R.string.home_load_older
                )
            )
        }
    }
}
