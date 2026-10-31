package dev.pneumo.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import dev.pneumo.app.R

data class PairUiState(
    val cameraGranted: Boolean,
    val cameraDenied: Boolean,
    val pasteMode: Boolean,
    val link: String,
    val error: String?
) {
    override fun toString(): String = "PairUiState([redacted])"
}

class PairActions(
    val onLinkChange: (String) -> Unit,
    val onPasteMode: (Boolean) -> Unit,
    val onOpenLink: () -> Unit,
    val onRequestCamera: () -> Unit
)

@Composable
fun PairScreen(
    state: PairUiState,
    actions: PairActions,
    modifier: Modifier = Modifier,
    cameraPreview: @Composable () -> Unit = {}
) {
    val pasteMode = state.pasteMode
    val link = state.link
    val error = state.error
    ScreenFrame(modifier = modifier) {
        BrandHeader()
        ScreenHeading(
            title = stringResource(R.string.pair_title),
            body = stringResource(R.string.pair_intro)
        )

        if (pasteMode) {
            PasteLinkContent(
                link = link,
                error = error,
                onLinkChange = actions.onLinkChange,
                onOpenLink = actions.onOpenLink,
                onScanInstead = { actions.onPasteMode(false) }
            )
        } else {
            CameraContent(
                state = state,
                onRequestCamera = actions.onRequestCamera,
                onPasteInstead = { actions.onPasteMode(true) },
                cameraPreview = cameraPreview
            )
        }
    }
}

@Composable
private fun CameraContent(
    state: PairUiState,
    onRequestCamera: () -> Unit,
    onPasteInstead: () -> Unit,
    cameraPreview: @Composable () -> Unit
) {
    val cameraGranted = state.cameraGranted
    val cameraDenied = state.cameraDenied
    val error = state.error
    Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
        if (cameraGranted) {
            val previewDescription = stringResource(R.string.pair_camera_preview)
            Box(
                modifier =
                    Modifier
                        .fillMaxWidth()
                        .height(224.dp)
                        .clip(MaterialTheme.shapes.large)
                        .background(MaterialTheme.colorScheme.surface)
                        .border(
                            width = 1.dp,
                            color = MaterialTheme.colorScheme.outline,
                            shape = MaterialTheme.shapes.large
                        )
                        .semantics { contentDescription = previewDescription },
                contentAlignment = Alignment.Center
            ) {
                cameraPreview()
            }
        } else {
            Text(
                text =
                    stringResource(
                        if (cameraDenied) R.string.pair_camera_denied else R.string.pair_camera_rationale
                    ),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodyLarge
            )
            PrimaryButton(
                onClick = onRequestCamera,
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)
            ) {
                Text(
                    stringResource(
                        if (cameraDenied) {
                            R.string.pair_open_camera_settings
                        } else {
                            R.string.pair_allow_camera
                        }
                    )
                )
            }
        }

        if (error != null) {
            ErrorMessage(error)
        }

        SecondaryButton(
            onClick = onPasteInstead,
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)
        ) {
            Text(stringResource(R.string.pair_paste_instead))
        }
    }
}

@Composable
private fun PasteLinkContent(
    link: String,
    error: String?,
    onLinkChange: (String) -> Unit,
    onOpenLink: () -> Unit,
    onScanInstead: () -> Unit
) {
    Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
        OutlinedTextField(
            value = link,
            onValueChange = onLinkChange,
            modifier = Modifier.fillMaxWidth(),
            label = { Text(stringResource(R.string.pair_link_label)) },
            placeholder = { Text(stringResource(R.string.pair_link_placeholder)) },
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions =
                KeyboardOptions(
                    keyboardType = KeyboardType.Password,
                    autoCorrectEnabled = false
                ),
            singleLine = true
        )

        if (error != null) {
            ErrorMessage(error)
        }

        PrimaryButton(
            onClick = onOpenLink,
            enabled = link.isNotBlank(),
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)
        ) {
            Text(stringResource(R.string.pair_open_link))
        }
        TextButton(
            onClick = onScanInstead,
            shape = MaterialTheme.shapes.medium,
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)
        ) {
            Text(stringResource(R.string.pair_scan_instead))
        }
    }
}
