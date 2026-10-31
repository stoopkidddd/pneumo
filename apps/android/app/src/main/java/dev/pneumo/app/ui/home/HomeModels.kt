package dev.pneumo.app.ui.home

import dev.pneumo.app.protocol.DeviceDTO
import dev.pneumo.app.sync.DecryptedPush

data class HomeComposerState(
    val text: String = "",
    val targetDeviceId: String? = null,
    val sending: Boolean = false,
    val error: String? = null
)

data class HomeUiState(
    val pushes: List<DecryptedPush> = emptyList(),
    val devices: List<DeviceDTO> = emptyList(),
    val loading: Boolean = true,
    val loadingMore: Boolean = false,
    val nextBefore: String? = null,
    val highlightRequestId: Long = 0L,
    val error: String? = null,
    val highlightedPushId: String? = null,
    val hiddenPushIds: Set<String> = emptySet(),
    val undoPushId: String? = null,
    val composer: HomeComposerState = HomeComposerState()
) {
    val visiblePushes: List<DecryptedPush>
        get() = if (hiddenPushIds.isEmpty()) pushes else pushes.filterNot { it.push.id in hiddenPushIds }
}
internal data class HomeActions(
    val onRetry: () -> Unit,
    val onLoadOlder: () -> Unit,
    val onTextChange: (String) -> Unit,
    val onTargetSelect: (String?) -> Unit,
    val onSend: () -> Unit,
    val onDelete: (String) -> Unit,
    val onUndoDelete: (String) -> Unit
)
internal data class HomeComposerActions(
    val onTextChange: (String) -> Unit,
    val onTargetSelect: (String?) -> Unit,
    val onSend: () -> Unit
)
