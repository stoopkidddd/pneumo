package dev.pneumo.app.ui.screens

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import dev.pneumo.app.R
import java.net.URI

@Composable
fun ConfirmScreen(state: ConfirmUiState, onConfirm: () -> Unit, onBack: () -> Unit, modifier: Modifier = Modifier) {
    val origin = state.origin
    val busy = state.busy
    val error = state.error
    val retryable = state.retryable
    val showInsecureWarning = state.showInsecureWarning
    val authority = remember(origin) { originAuthority(origin) }
    ScreenFrame(modifier = modifier) {
        BrandHeader()
        ScreenHeading(
            title = stringResource(R.string.confirm_title, authority),
            body = stringResource(R.string.confirm_intro)
        )

        Surface(
            color = MaterialTheme.colorScheme.surface,
            shape = MaterialTheme.shapes.medium,
            border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline)
        ) {
            Column(
                modifier = Modifier.fillMaxWidth().padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp)
            ) {
                Text(
                    text = stringResource(R.string.confirm_server_label),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.labelMedium
                )
                Text(text = origin, style = MaterialTheme.typography.bodyLarge)
            }
        }

        if (showInsecureWarning) {
            WarningMessage(stringResource(R.string.confirm_insecure_warning))
        }
        if (error != null) {
            ErrorMessage(error)
        }

        ConfirmActions(
            busy = busy,
            error = error,
            retryable = retryable,
            onConfirm = onConfirm,
            onBack = onBack
        )
    }
}

@Composable
private fun ConfirmActions(
    busy: Boolean,
    error: String?,
    retryable: Boolean,
    onConfirm: () -> Unit,
    onBack: () -> Unit
) {
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        when {
            error != null && !retryable -> {
                PrimaryButton(
                    onClick = onBack,
                    modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)
                ) {
                    Text(stringResource(R.string.confirm_new_code))
                }
            }

            else -> {
                PrimaryButton(
                    onClick = onConfirm,
                    enabled = !busy,
                    modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)
                ) {
                    Row(
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        if (busy) {
                            CircularProgressIndicator(
                                modifier = Modifier.size(20.dp),
                                color = LocalContentColor.current,
                                strokeWidth = 2.dp
                            )
                        }
                        Text(
                            stringResource(
                                if (error != null && retryable) {
                                    R.string.confirm_retry
                                } else {
                                    R.string.confirm_action
                                }
                            )
                        )
                    }
                }
                SecondaryButton(
                    onClick = onBack,
                    enabled = !busy,
                    modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)
                ) {
                    Text(stringResource(R.string.confirm_back))
                }
            }
        }
    }
}

internal fun originAuthority(origin: String): String = runCatching { URI(origin).rawAuthority }
    .getOrNull()
    ?.takeIf { it.isNotBlank() }
    ?: origin
