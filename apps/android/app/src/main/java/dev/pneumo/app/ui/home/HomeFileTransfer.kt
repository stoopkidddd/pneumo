package dev.pneumo.app.ui.home

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import dev.pneumo.app.R
import dev.pneumo.app.transfer.DownloadActions
import dev.pneumo.app.transfer.DownloadScheduler
import dev.pneumo.app.transfer.DownloadState
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

@Composable
internal fun HomeFileTransfer(pushId: String, mime: String, state: DownloadState?) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var enqueueError by remember(pushId) { mutableStateOf<String?>(null) }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        enqueueError?.let { message ->
            Text(message, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
        }
        when (state) {
            is DownloadState.Downloading -> {
                Text(stringResource(R.string.transfer_downloading), style = MaterialTheme.typography.labelMedium)
                val progress = state.progress
                if (progress == null) {
                    LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
                } else {
                    LinearProgressIndicator(progress = { progress / 100f }, modifier = Modifier.fillMaxWidth())
                }
            }

            is DownloadState.Done -> Row {
                TextButton(onClick = { DownloadActions.open(context, state.uri, mime) }) {
                    Text(stringResource(R.string.transfer_open))
                }
                TextButton(onClick = { DownloadActions.share(context, state.uri, mime) }) {
                    Text(stringResource(R.string.transfer_share))
                }
            }

            else -> {
                if (state is DownloadState.Failed) {
                    Text(
                        state.message,
                        modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodyMedium
                    )
                }
                TextButton(onClick = {
                    scope.launch {
                        try {
                            DownloadScheduler.enqueue(context, pushId)
                            enqueueError = null
                        } catch (cancelled: CancellationException) {
                            throw cancelled
                        } catch (_: Exception) {
                            enqueueError = "Could not start the download. Try again."
                        }
                    }
                }) {
                    Text(
                        stringResource(
                            if (state is DownloadState.Failed) R.string.transfer_retry else R.string.transfer_download
                        )
                    )
                }
            }
        }
    }
}
