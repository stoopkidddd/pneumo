package dev.pneumo.app.ui.devices

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import dev.pneumo.app.protocol.Platform
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

internal data class DeviceUiModel(
    val id: String,
    val name: String,
    val platform: Platform,
    val lastSeenAt: String,
    val online: Boolean,
    val isOwn: Boolean
)

internal data class DevicesUiState(
    val loading: Boolean = true,
    val devices: List<DeviceUiModel> = emptyList(),
    val editingDeviceId: String? = null,
    val renameDraft: String = "",
    val confirmingRemovalId: String? = null,
    val busyDeviceId: String? = null,
    val error: String? = null
)

internal sealed interface DevicesEffect {
    data object OpenSettings : DevicesEffect
}

internal class DevicesViewModel(private val repository: DeviceRepository, private val ownDeviceId: String) :
    ViewModel() {
    private val mutableState = MutableStateFlow(DevicesUiState())
    val state: StateFlow<DevicesUiState> = mutableState.asStateFlow()

    private val effectChannel = Channel<DevicesEffect>(Channel.BUFFERED)
    val effects = effectChannel.receiveAsFlow()

    init {
        viewModelScope.launch {
            repository.observeDevices().collect { devices ->
                val visible = devices
                    .sortedWith(
                        compareByDescending<DeviceItem> { it.id == ownDeviceId }
                            .thenBy { it.createdAt }
                            .thenBy { it.id }
                    )
                    .map { it.toUiModel() }
                mutableState.update { current ->
                    current.copy(
                        loading = current.loading && visible.isEmpty(),
                        devices = visible,
                        editingDeviceId = current.editingDeviceId?.takeIf { id -> visible.any { it.id == id } },
                        confirmingRemovalId =
                            current.confirmingRemovalId?.takeIf { id -> visible.any { it.id == id } }
                    )
                }
            }
        }
        refresh()
    }

    fun retry() {
        refresh()
    }

    fun beginRename(id: String) {
        val device = mutableState.value.devices.firstOrNull { it.id == id } ?: return
        if (mutableState.value.busyDeviceId != null) return
        mutableState.update {
            it.copy(
                editingDeviceId = id,
                renameDraft = device.name,
                confirmingRemovalId = null,
                error = null
            )
        }
    }

    fun updateRenameDraft(name: String) {
        if (mutableState.value.editingDeviceId == null) return
        mutableState.update { it.copy(renameDraft = name, error = null) }
    }

    fun cancelRename() {
        if (mutableState.value.busyDeviceId != null) return
        mutableState.update { it.copy(editingDeviceId = null, renameDraft = "", error = null) }
    }

    fun saveRename() {
        val current = mutableState.value
        val id = current.editingDeviceId
        val name = current.renameDraft.trim()
        val existing = current.devices.firstOrNull { it.id == id }
        val canRename = current.busyDeviceId == null && name.isNotEmpty() && name != existing?.name
        if (id != null && existing != null && canRename) {
            viewModelScope.launch {
                mutableState.update { it.copy(busyDeviceId = id, error = null) }
                runCatching { repository.rename(id, name) }
                    .onSuccess {
                        mutableState.update {
                            it.copy(
                                editingDeviceId = null,
                                renameDraft = "",
                                busyDeviceId = null
                            )
                        }
                    }
                    .onFailure { failure ->
                        if (failure is CancellationException) throw failure
                        mutableState.update {
                            it.copy(busyDeviceId = null, error = RENAME_ERROR)
                        }
                    }
            }
        }
    }

    fun requestRemove(id: String) {
        val current = mutableState.value
        if (current.busyDeviceId != null || current.devices.none { it.id == id }) return
        if (id == ownDeviceId) {
            effectChannel.trySend(DevicesEffect.OpenSettings)
            return
        }
        mutableState.update {
            it.copy(
                confirmingRemovalId = id,
                editingDeviceId = null,
                renameDraft = "",
                error = null
            )
        }
    }

    fun cancelRemove() {
        if (mutableState.value.busyDeviceId != null) return
        mutableState.update { it.copy(confirmingRemovalId = null, error = null) }
    }

    fun confirmRemove() {
        val current = mutableState.value
        val id = current.confirmingRemovalId ?: return
        if (id == ownDeviceId || current.busyDeviceId != null) return
        viewModelScope.launch {
            mutableState.update { it.copy(busyDeviceId = id, error = null) }
            runCatching { repository.remove(id) }
                .onSuccess {
                    mutableState.update {
                        it.copy(confirmingRemovalId = null, busyDeviceId = null)
                    }
                }
                .onFailure { failure ->
                    if (failure is CancellationException) throw failure
                    mutableState.update {
                        it.copy(busyDeviceId = null, error = REMOVE_ERROR)
                    }
                }
        }
    }

    private fun refresh() {
        if (mutableState.value.busyDeviceId != null) return
        viewModelScope.launch {
            if (mutableState.value.devices.isEmpty()) {
                mutableState.update { it.copy(loading = true, error = null) }
            } else {
                mutableState.update { it.copy(error = null) }
            }
            runCatching { repository.refresh() }
                .onFailure { failure ->
                    if (failure is CancellationException) throw failure
                    mutableState.update { it.copy(error = LOAD_ERROR) }
                }
            mutableState.update { it.copy(loading = false) }
        }
    }

    private fun DeviceItem.toUiModel(): DeviceUiModel = DeviceUiModel(
        id = id,
        name = name,
        platform = platform,
        lastSeenAt = lastSeenAt,
        online = online,
        isOwn = id == ownDeviceId
    )

    companion object {
        fun factory(repository: DeviceRepository, ownDeviceId: String): ViewModelProvider.Factory =
            object : ViewModelProvider.Factory {
                @Suppress("UNCHECKED_CAST")
                override fun <T : ViewModel> create(modelClass: Class<T>): T =
                    DevicesViewModel(repository, ownDeviceId) as T
            }

        private const val LOAD_ERROR = "Could not load devices. Check your connection and try again."
        private const val RENAME_ERROR = "Could not rename this device. Check your connection and try again."
        private const val REMOVE_ERROR = "Could not remove this device. Check your connection and try again."
    }
}
