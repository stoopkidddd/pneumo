package dev.pneumo.app.ui.devices

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.pneumo.app.R
import dev.pneumo.app.data.AppSession
import dev.pneumo.app.data.db.PneumoDatabase
import dev.pneumo.app.ui.screens.ErrorMessage
import java.time.Instant
import kotlinx.coroutines.delay

@Composable
internal fun DevicesRoute(
    session: AppSession,
    database: PneumoDatabase,
    onOpenSettings: () -> Unit,
    modifier: Modifier = Modifier,
    devicesViewModel: DevicesViewModel =
        viewModel(
            key = "devices-${session.deviceId}-${session.generation}",
            factory =
                DevicesViewModel.factory(
                    repository =
                        remember(session.api, session.cache, session.generation, database) {
                            RoomDeviceRepository(
                                session.api,
                                database.devices(),
                                database.invalidationTracker,
                                session.cache,
                                session.generation
                            )
                        },
                    ownDeviceId = session.deviceId
                )
        )
) {
    val state by devicesViewModel.state.collectAsStateWithLifecycle()
    var now by remember { mutableStateOf(Instant.now()) }
    LaunchedEffect(devicesViewModel) {
        while (true) {
            delay(LAST_SEEN_REFRESH_MILLIS)
            now = Instant.now()
        }
    }
    LaunchedEffect(devicesViewModel, onOpenSettings) {
        devicesViewModel.effects.collect { effect ->
            when (effect) {
                DevicesEffect.OpenSettings -> onOpenSettings()
            }
        }
    }
    DevicesScreen(
        state = state,
        actions =
            DevicesActions(
                onRetry = devicesViewModel::retry,
                onBeginRename = devicesViewModel::beginRename,
                onRenameChange = devicesViewModel::updateRenameDraft,
                onSaveRename = devicesViewModel::saveRename,
                onCancelRename = devicesViewModel::cancelRename,
                onRequestRemove = devicesViewModel::requestRemove,
                onConfirmRemove = devicesViewModel::confirmRemove,
                onCancelRemove = devicesViewModel::cancelRemove
            ),
        now = now,
        modifier = modifier
    )
}

internal data class DevicesActions(
    val onRetry: () -> Unit,
    val onBeginRename: (String) -> Unit,
    val onRenameChange: (String) -> Unit,
    val onSaveRename: () -> Unit,
    val onCancelRename: () -> Unit,
    val onRequestRemove: (String) -> Unit,
    val onConfirmRemove: () -> Unit,
    val onCancelRemove: () -> Unit
) {
    companion object {
        val None = DevicesActions({}, {}, {}, {}, {}, {}, {}, {})
    }
}

@Composable
internal fun DevicesScreen(
    state: DevicesUiState,
    actions: DevicesActions,
    now: Instant,
    modifier: Modifier = Modifier
) {
    Column(
        modifier = modifier.fillMaxSize().verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(24.dp)
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(text = stringResource(R.string.devices_title), style = MaterialTheme.typography.headlineMedium)
            Text(
                text = stringResource(R.string.devices_body),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodyLarge
            )
        }
        when {
            state.loading -> LoadingDevices()

            state.devices.isEmpty() && state.error != null -> DeviceLoadError(state.error, actions.onRetry)

            state.devices.isEmpty() -> EmptyDevices()

            else -> {
                if (state.error != null) {
                    if (state.editingDeviceId == null && state.confirmingRemovalId == null) {
                        DeviceLoadError(state.error, actions.onRetry)
                    } else {
                        ErrorMessage(state.error)
                    }
                }
                Surface(
                    color = MaterialTheme.colorScheme.surface,
                    shape = MaterialTheme.shapes.medium,
                    border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline)
                ) {
                    Column {
                        state.devices.forEachIndexed { index, device ->
                            if (index > 0) HorizontalDivider(color = MaterialTheme.colorScheme.outline)
                            DeviceRow(
                                state =
                                    DeviceRowState(
                                        device = device,
                                        editing = state.editingDeviceId == device.id,
                                        renameDraft = state.renameDraft,
                                        confirmingRemoval = state.confirmingRemovalId == device.id,
                                        busy = state.busyDeviceId == device.id,
                                        controlsEnabled = state.busyDeviceId == null,
                                        now = now
                                    ),
                                actions = actions
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun LoadingDevices() {
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        LinearProgressIndicator(modifier = Modifier.fillMaxWidth(), color = MaterialTheme.colorScheme.primary)
        Text(
            text = stringResource(R.string.devices_loading),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.bodyMedium
        )
    }
}

@Composable
private fun DeviceLoadError(error: String, onRetry: () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
        ErrorMessage(error)
        OutlinedButton(
            onClick = onRetry,
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
            shape = MaterialTheme.shapes.medium,
            border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline)
        ) {
            Text(stringResource(R.string.devices_try_again))
        }
    }
}

@Composable
private fun EmptyDevices() {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(text = stringResource(R.string.devices_empty_title), style = MaterialTheme.typography.titleMedium)
        Text(
            text = stringResource(R.string.devices_empty_body),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.bodyLarge
        )
    }
}

private const val LAST_SEEN_REFRESH_MILLIS = 30_000L
