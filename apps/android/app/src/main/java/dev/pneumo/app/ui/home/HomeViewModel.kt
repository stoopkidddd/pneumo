package dev.pneumo.app.ui.home

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import dev.pneumo.app.data.TextPushes
import dev.pneumo.app.protocol.DeviceDTO
import java.io.IOException
import java.util.Locale
import javax.crypto.SecretKey
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.supervisorScope

internal class HomeViewModel(
    private val source: HomeDataSource,
    private val contentKey: SecretKey,
    private val maxEnvelopeBytes: Long
) : ViewModel() {
    private val mutableState = MutableStateFlow(HomeUiState())
    val state: StateFlow<HomeUiState> = mutableState.asStateFlow()

    private val deleteJobs = mutableMapOf<String, Job>()
    private var refreshJob: Job? = null
    private var loadOlderJob: Job? = null
    private var boundaryRepairJob: Job? = null
    private var selectPushJob: Job? = null
    private var selectionRequest = 0L
    init {
        viewModelScope.launch {
            source.history
                .catch {
                    mutableState.update { state ->
                        state.copy(loading = false, error = HISTORY_DECRYPT_ERROR)
                    }
                }
                .collect { pushes ->
                    val previous = mutableState.value
                    val missingBoundary = previous.nextBefore?.takeIf { boundary ->
                        previous.pushes.any { item -> item.push.id == boundary } &&
                            pushes.none { item -> item.push.id == boundary }
                    }
                    mutableState.update { state ->
                        state.copy(
                            pushes = pushes,
                            loading = if (pushes.isNotEmpty()) false else state.loading
                        )
                    }
                    if (missingBoundary != null) repairPaginationBoundary(missingBoundary)
                }
        }
        viewModelScope.launch {
            source.devices
                .catch {
                    mutableState.update { state -> state.copy(loading = false, error = REFRESH_ERROR) }
                }
                .collect(mutableState::setDevices)
        }
        refreshJob = viewModelScope.launch { refresh() }
    }

    fun retry() {
        if (refreshJob?.isActive == true) return
        boundaryRepairJob?.cancel()
        loadOlderJob?.cancel()
        mutableState.update { state ->
            state.copy(loading = state.pushes.isEmpty(), loadingMore = false, error = null)
        }
        refreshJob = viewModelScope.launch { refresh() }
    }

    fun loadOlder() {
        val before = mutableState.value.nextBefore ?: return
        if (mutableState.value.loadingMore) return
        mutableState.update { it.copy(loadingMore = true, error = null) }
        loadOlderJob = viewModelScope.launch {
            try {
                val page = source.loadPage(before)
                if (page.pushes.isEmpty() && mutableState.value.pushes.none { item -> item.push.id == before }) {
                    repairPaginationBoundary(before)
                } else {
                    mutableState.update {
                        it.copy(loadingMore = false, nextBefore = page.nextBefore)
                    }
                }
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (_: Exception) {
                mutableState.update {
                    it.copy(loadingMore = false, error = LOAD_MORE_ERROR)
                }
            }
        }
    }

    fun updateComposerText(text: String) {
        mutableState.update { state ->
            state.copy(composer = state.composer.copy(text = text, error = null))
        }
    }

    fun selectTarget(deviceId: String?) {
        val validTarget = deviceId?.takeIf { selected ->
            mutableState.value.devices.any { device -> device.id == selected }
        }
        mutableState.update { state ->
            state.copy(composer = state.composer.copy(targetDeviceId = validTarget, error = null))
        }
    }

    fun send() {
        val composer = mutableState.value.composer
        if (composer.sending || composer.text.isBlank()) return
        mutableState.update { state ->
            state.copy(composer = state.composer.copy(sending = true, error = null))
        }
        viewModelScope.launch {
            try {
                val payload = TextPushes.payload(composer.text)
                val envelopeLimit = try {
                    source.maxEnvelopeBytes()
                } catch (cancellation: CancellationException) {
                    throw cancellation
                } catch (_: IOException) {
                    maxEnvelopeBytes
                }
                val request = TextPushes.request(
                    payload = payload,
                    targetDeviceId = composer.targetDeviceId,
                    contentKey = contentKey,
                    maxEnvelopeBytes = envelopeLimit
                )
                source.createPush(request)
                mutableState.update { state ->
                    state.copy(composer = HomeComposerState(targetDeviceId = state.composer.targetDeviceId))
                }
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (failure: IllegalArgumentException) {
                mutableState.sendFailed(failure.message ?: SEND_ERROR)
            } catch (_: Exception) {
                mutableState.sendFailed(SEND_ERROR)
            }
        }
    }

    fun delete(pushId: String) {
        if (deleteJobs.containsKey(pushId)) return
        mutableState.update { state ->
            state.copy(
                hiddenPushIds = state.hiddenPushIds + pushId,
                undoPushId = pushId,
                error = null
            )
        }
        deleteJobs[pushId] = viewModelScope.launch {
            try {
                delay(DELETE_GRACE_MILLIS)
                mutableState.update { state ->
                    state.copy(undoPushId = state.undoPushId.takeUnless { it == pushId })
                }
                source.deletePush(pushId)
                mutableState.update { state ->
                    state.copy(
                        hiddenPushIds = state.hiddenPushIds - pushId,
                        undoPushId = state.undoPushId.takeUnless { it == pushId }
                    )
                }
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (_: Exception) {
                mutableState.update { state ->
                    state.copy(
                        hiddenPushIds = state.hiddenPushIds - pushId,
                        undoPushId = state.undoPushId.takeUnless { it == pushId },
                        error = DELETE_ERROR
                    )
                }
            } finally {
                deleteJobs.remove(pushId)
            }
        }
    }

    fun undoDelete(pushId: String) {
        if (mutableState.value.undoPushId != pushId) return
        deleteJobs.remove(pushId)?.cancel()
        mutableState.update { state ->
            state.copy(
                hiddenPushIds = state.hiddenPushIds - pushId,
                undoPushId = null
            )
        }
    }

    fun selectPush(pushId: String, navigationId: Long) {
        val request = ++selectionRequest
        selectPushJob?.cancel()
        selectPushJob = viewModelScope.launch {
            val stored = mutableState.value.pushes.any { item -> item.push.id == pushId }
            if (!stored) {
                try {
                    source.loadPush(pushId)
                } catch (cancellation: CancellationException) {
                    throw cancellation
                } catch (_: Exception) {
                    if (request == selectionRequest) {
                        mutableState.update { it.copy(error = FIND_PUSH_ERROR) }
                    }
                    return@launch
                }
            }
            if (request != selectionRequest) return@launch
            mutableState.update {
                it.copy(
                    highlightedPushId = pushId,
                    highlightRequestId = navigationId,
                    error = null
                )
            }
        }
    }

    private fun repairPaginationBoundary(missingBoundary: String) {
        if (boundaryRepairJob?.isActive == true || mutableState.value.nextBefore != missingBoundary) return
        loadOlderJob?.cancel()
        mutableState.update { state ->
            state.copy(nextBefore = null, loadingMore = true)
        }
        boundaryRepairJob = viewModelScope.launch {
            try {
                val page = source.loadPage(before = null)
                mutableState.update {
                    it.copy(loadingMore = false, nextBefore = page.nextBefore)
                }
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (_: Exception) {
                mutableState.update {
                    it.copy(loadingMore = false, error = LOAD_MORE_ERROR)
                }
            }
        }
    }

    private suspend fun refresh() {
        mutableState.update { it.copy(error = null) }
        val (pageResult, devicesResult) = supervisorScope {
            val page = async { apiResult { source.loadPage(before = null) } }
            val devices = async { apiResult { source.refreshDevices() } }
            page.await() to devices.await()
        }
        pageResult.onSuccess { page ->
            mutableState.update { it.copy(nextBefore = page.nextBefore) }
        }
        mutableState.update {
            it.copy(
                loading = false,
                error = if (pageResult.isFailure || devicesResult.isFailure) REFRESH_ERROR else null
            )
        }
    }

    internal companion object {
        const val DELETE_GRACE_MILLIS = 5_000L
        private const val REFRESH_ERROR = "Could not load your history or devices. Check your connection and try again."
        private const val LOAD_MORE_ERROR = "Could not load older pushes. Try again."
        private const val HISTORY_DECRYPT_ERROR = "Could not decrypt your local history."
        private const val SEND_ERROR = "Could not send. Check your connection and try again."
        private const val DELETE_ERROR = "Could not delete this push. Check your connection and try again."
        private const val FIND_PUSH_ERROR = "Could not find that push. It may have been deleted."
    }
}

internal class HomeViewModelFactory(
    private val source: HomeDataSource,
    private val contentKey: SecretKey,
    private val maxEnvelopeBytes: Long
) : ViewModelProvider.Factory {
    override fun <T : ViewModel> create(modelClass: Class<T>): T =
        requireNotNull(modelClass.cast(HomeViewModel(source, contentKey, maxEnvelopeBytes)))
}

private suspend fun <T> apiResult(block: suspend () -> T): Result<T> {
    val result = runCatching { block() }
    val failure = result.exceptionOrNull()
    if (failure is CancellationException) throw failure
    if (failure != null && failure !is Exception) throw failure
    return result
}

private fun MutableStateFlow<HomeUiState>.sendFailed(message: String) {
    update { state ->
        state.copy(composer = state.composer.copy(sending = false, error = message))
    }
}

private fun MutableStateFlow<HomeUiState>.setDevices(devices: List<DeviceDTO>) {
    val sorted = devices.sortedWith(compareBy<DeviceDTO> { it.name.lowercase(Locale.ROOT) }.thenBy { it.id })
    update { state ->
        val selected = state.composer.targetDeviceId?.takeIf { id ->
            sorted.any { device -> device.id == id }
        }
        state.copy(
            devices = sorted,
            composer = state.composer.copy(targetDeviceId = selected)
        )
    }
}
