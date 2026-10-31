package dev.pneumo.app.ui.screens

data class ConfirmUiState(
    val origin: String,
    val busy: Boolean,
    val error: String?,
    val retryable: Boolean,
    val showInsecureWarning: Boolean
)
