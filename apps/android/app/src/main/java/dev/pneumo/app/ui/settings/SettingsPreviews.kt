package dev.pneumo.app.ui.settings

import android.content.res.Configuration
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.tooling.preview.PreviewParameter
import androidx.compose.ui.tooling.preview.PreviewParameterProvider
import androidx.compose.ui.unit.dp
import dev.pneumo.app.net.ws.ConnectionState
import dev.pneumo.app.ui.theme.PneumoTheme

enum class SettingsPreviewCase(val fileName: String) {
    NotificationsOnBatteryExempt("settings-notifications-on-battery-exempt"),
    NotificationsOffBatteryExempt("settings-notifications-off-battery-exempt"),
    NotificationsOnBatteryOptimized("settings-notifications-on-battery-optimized"),
    NotificationsOffBatteryOptimized("settings-notifications-off-battery-optimized"),
    Busy("settings-sign-out-busy"),
    Error("settings-sign-out-error")
}

internal class SettingsPreviewProvider : PreviewParameterProvider<SettingsPreviewCase> {
    override val values: Sequence<SettingsPreviewCase> = SettingsPreviewCase.entries.asSequence()
}

internal object SettingsPreviewFixtures {
    fun state(case: SettingsPreviewCase): SettingsUiState {
        val notificationsEnabled =
            case != SettingsPreviewCase.NotificationsOffBatteryExempt &&
                case != SettingsPreviewCase.NotificationsOffBatteryOptimized
        val batteryExempt =
            case != SettingsPreviewCase.NotificationsOnBatteryOptimized &&
                case != SettingsPreviewCase.NotificationsOffBatteryOptimized
        return SettingsUiState(
            authority = "pneumo.example.com:8443",
            connection = ConnectionState.Connected,
            notificationsEnabled = notificationsEnabled,
            batteryExempt = batteryExempt,
            versionName = "0.0.1",
            signOutBusy = case == SettingsPreviewCase.Busy,
            signOutError =
                if (case == SettingsPreviewCase.Error) {
                    "Could not reach the server. Try signing out again."
                } else {
                    null
                }
        )
    }
}

@Composable
internal fun SettingsPreviewContent(case: SettingsPreviewCase, modifier: Modifier = Modifier) {
    Surface(modifier = modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        SettingsScreen(
            state = SettingsPreviewFixtures.state(case),
            actions = SettingsActions.None,
            modifier = Modifier.padding(24.dp)
        )
    }
}

@Preview(name = "Light", widthDp = 360, heightDp = 800)
@Preview(name = "Dark", widthDp = 360, heightDp = 800, uiMode = Configuration.UI_MODE_NIGHT_YES)
@Composable
internal fun SettingsStatesPreview(@PreviewParameter(SettingsPreviewProvider::class) case: SettingsPreviewCase) {
    PneumoTheme { SettingsPreviewContent(case) }
}
