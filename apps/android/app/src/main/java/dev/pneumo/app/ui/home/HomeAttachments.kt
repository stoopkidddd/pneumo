package dev.pneumo.app.ui.home

import android.net.Uri
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** Owns picker snapshots until confirmed enqueue transfers ownership to WorkManager. */
internal class HomeAttachments(
    private val source: HomeDataSource,
    private val state: MutableStateFlow<HomeUiState>,
    private val scope: CoroutineScope
) {
    init {
        requireNotNull(scope.coroutineContext[Job]).invokeOnCompletion {
            source.discardUploads(state.value.composer.attachments)
        }
    }

    fun select(uris: List<Uri>) {
        if (uris.isEmpty()) return
        val composer = state.value.composer
        if (composer.sending || composer.preparingAttachments) return
        state.update { it.copy(composer = it.composer.copy(preparingAttachments = true, error = null)) }
        scope.launch {
            try {
                val prepared = source.prepareUploads(uris)
                source.discardUploads(composer.attachments)
                state.update {
                    it.copy(composer = it.composer.copy(attachments = prepared, preparingAttachments = false))
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                state.update {
                    it.copy(
                        composer = it.composer.copy(
                            preparingAttachments = false,
                            error = "Could not read the selected files. Choose them again."
                        )
                    )
                }
            }
        }
    }

    fun remove() {
        val composer = state.value.composer
        if (composer.sending || composer.preparingAttachments) return
        source.discardUploads(composer.attachments)
        state.update { it.copy(composer = it.composer.copy(attachments = emptyList(), error = null)) }
    }
}
