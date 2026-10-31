package dev.pneumo.app.ui.devices

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
import dev.pneumo.app.protocol.Platform
import dev.pneumo.app.ui.theme.PneumoTheme
import java.time.Instant

enum class DevicesPreviewCase(val fileName: String) {
    Loading("devices-loading"),
    Empty("devices-empty"),
    List("devices-list"),
    Rename("devices-rename"),
    RenameBusy("devices-rename-busy"),
    Remove("devices-remove"),
    RemoveBusy("devices-remove-busy"),
    Error("devices-error")
}

internal class DevicesPreviewProvider : PreviewParameterProvider<DevicesPreviewCase> {
    override val values: Sequence<DevicesPreviewCase> = DevicesPreviewCase.entries.asSequence()
}

internal object DevicesPreviewFixtures {
    val now: Instant = Instant.parse("2026-10-31T12:00:00.000Z")

    fun state(case: DevicesPreviewCase): DevicesUiState = when (case) {
        DevicesPreviewCase.Loading -> DevicesUiState(loading = true)

        DevicesPreviewCase.Empty -> DevicesUiState(loading = false)

        DevicesPreviewCase.List -> DevicesUiState(loading = false, devices = devices)

        DevicesPreviewCase.Rename ->
            DevicesUiState(
                loading = false,
                devices = listOf(devices.first()),
                editingDeviceId = OWN_ID,
                renameDraft = "Pixel 9 Pro"
            )

        DevicesPreviewCase.RenameBusy ->
            DevicesUiState(
                loading = false,
                devices = listOf(devices.first()),
                editingDeviceId = OWN_ID,
                renameDraft = "Pixel 9 Pro",
                busyDeviceId = OWN_ID
            )

        DevicesPreviewCase.Remove ->
            DevicesUiState(
                loading = false,
                devices = listOf(devices.last()),
                confirmingRemovalId = BROWSER_ID
            )

        DevicesPreviewCase.RemoveBusy ->
            DevicesUiState(
                loading = false,
                devices = listOf(devices.last()),
                confirmingRemovalId = BROWSER_ID,
                busyDeviceId = BROWSER_ID
            )

        DevicesPreviewCase.Error ->
            DevicesUiState(
                loading = false,
                error = "Could not load devices. Check your connection and try again."
            )
    }

    private val devices =
        listOf(
            DeviceUiModel(
                id = OWN_ID,
                name = "Pixel 9",
                platform = Platform.ANDROID,
                lastSeenAt = "2026-10-31T11:59:42.000Z",
                online = true,
                isOwn = true
            ),
            DeviceUiModel(
                id = BROWSER_ID,
                name = "Firefox on Linux",
                platform = Platform.WEB,
                lastSeenAt = "2026-10-31T09:32:00.000Z",
                online = false,
                isOwn = false
            )
        )

    private const val OWN_ID = "019a3ce4-3a80-7000-8000-000000000001"
    private const val BROWSER_ID = "019a3ce4-3a80-7000-8000-000000000002"
}

@Composable
internal fun DevicesPreviewContent(case: DevicesPreviewCase, modifier: Modifier = Modifier) {
    Surface(modifier = modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        DevicesScreen(
            state = DevicesPreviewFixtures.state(case),
            actions = DevicesActions.None,
            now = DevicesPreviewFixtures.now,
            modifier = Modifier.padding(24.dp)
        )
    }
}

@Preview(name = "Light", widthDp = 360, heightDp = 800)
@Preview(name = "Dark", widthDp = 360, heightDp = 800, uiMode = Configuration.UI_MODE_NIGHT_YES)
@Composable
internal fun DevicesStatesPreview(@PreviewParameter(DevicesPreviewProvider::class) case: DevicesPreviewCase) {
    PneumoTheme { DevicesPreviewContent(case) }
}
