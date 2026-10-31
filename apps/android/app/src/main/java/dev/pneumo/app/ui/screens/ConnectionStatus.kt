package dev.pneumo.app.ui.screens

import android.content.res.Configuration
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.tooling.preview.PreviewParameter
import androidx.compose.ui.tooling.preview.PreviewParameterProvider
import androidx.compose.ui.unit.dp
import dev.pneumo.app.R
import dev.pneumo.app.net.ws.ConnectionState
import dev.pneumo.app.ui.theme.PneumoTheme

@Composable
fun ConnectionStatus(state: ConnectionState, modifier: Modifier = Modifier) {
    val label = when (state) {
        ConnectionState.Connected -> R.string.connection_connected
        ConnectionState.Reconnecting -> R.string.connection_reconnecting
        ConnectionState.Offline -> R.string.connection_offline
    }
    Row(modifier = modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(
            text = stringResource(R.string.connection_label),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        Text(
            text = stringResource(label),
            style = MaterialTheme.typography.bodyMedium,
            color = if (state == ConnectionState.Connected) {
                MaterialTheme.colorScheme.primary
            } else {
                MaterialTheme.colorScheme.onSurface
            }
        )
    }
}

class ConnectionPreviewProvider : PreviewParameterProvider<ConnectionState> {
    override val values: Sequence<ConnectionState> = ConnectionState.entries.asSequence()
}

@Preview(name = "Light", widthDp = 360)
@Preview(name = "Dark", widthDp = 360, uiMode = Configuration.UI_MODE_NIGHT_YES)
@Composable
internal fun ConnectionStatusPreview(@PreviewParameter(ConnectionPreviewProvider::class) state: ConnectionState) {
    PneumoTheme { ConnectionStatusFixture(state) }
}

@Composable
internal fun ConnectionStatusFixture(state: ConnectionState) {
    Surface(color = MaterialTheme.colorScheme.background) {
        Column(Modifier.padding(24.dp)) { ConnectionStatus(state) }
    }
}
