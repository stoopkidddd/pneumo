package dev.pneumo.app.ui.home

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel as composeViewModel
import androidx.work.WorkInfo
import androidx.work.WorkManager
import dev.pneumo.app.data.AppSession
import dev.pneumo.app.data.db.PneumoDatabase
import dev.pneumo.app.net.ws.ConnectionState
import dev.pneumo.app.transfer.DownloadTransfers
import dev.pneumo.app.transfer.UploadScheduler

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
private fun rememberHomeViewModelFactory(session: AppSession, database: PneumoDatabase): HomeViewModelFactory {
    val context = LocalContext.current.applicationContext
    return remember(session, database, context) {
        HomeViewModelFactory(
            source = RoomHomeDataSource(session, database, context),
            contentKey = session.contentKey,
            maxEnvelopeBytes = session.maxEnvelopeBytes
        )
    }
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
    val context = LocalContext.current
    val picker = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenMultipleDocuments(),
        viewModel.attachments::select
    )
    val downloads by remember(context) { DownloadTransfers.observe(context) }
        .collectAsStateWithLifecycle(initialValue = emptyMap())
    val uploads by remember(context) {
        WorkManager.getInstance(context).getWorkInfosByTagFlow(UploadScheduler.WORK_TAG)
    }.collectAsStateWithLifecycle(initialValue = emptyList())
    val activeUpload = uploads.firstOrNull { !it.state.isFinished }
    val uploadFailure = uploads.firstOrNull { it.state == WorkInfo.State.FAILED }
        ?.outputData?.getString(UploadScheduler.ERROR_MESSAGE)

    LaunchedEffect(pushId, navigationId) {
        pushId?.let { selected -> viewModel.selectPush(selected, navigationId) }
    }

    HomeScreen(
        state = state.copy(
            downloads = downloads,
            composer = state.composer.copy(
                uploadProgress = activeUpload?.progress?.getInt(UploadScheduler.PROGRESS_PERCENT, 0),
                uploadError = uploadFailure
            )
        ),
        connection = connection,
        actions = HomeActions(
            onRetry = viewModel::retry,
            onLoadOlder = viewModel::loadOlder,
            onTextChange = viewModel::updateComposerText,
            onTargetSelect = viewModel::selectTarget,
            onSend = viewModel::send,
            onDelete = viewModel::delete,
            onUndoDelete = viewModel::undoDelete,
            onAttach = { picker.launch(arrayOf("*/*")) },
            onRemoveAttachments = viewModel.attachments::remove
        ),
        modifier = modifier
    )
}
