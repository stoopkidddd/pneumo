package dev.pneumo.app.ui.devices

import java.time.Instant

internal data class DeviceRowState(
    val device: DeviceUiModel,
    val editing: Boolean,
    val renameDraft: String,
    val confirmingRemoval: Boolean,
    val busy: Boolean,
    val controlsEnabled: Boolean,
    val now: Instant
)
