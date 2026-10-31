package dev.pneumo.app.ui.screens

import android.content.res.Configuration
import androidx.compose.runtime.Composable
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.tooling.preview.PreviewParameter
import androidx.compose.ui.tooling.preview.PreviewParameterProvider
import dev.pneumo.app.ui.theme.PneumoTheme

class ScreenPreviewProvider : PreviewParameterProvider<ScreenPreviewCase> {
    override val values: Sequence<ScreenPreviewCase> = ScreenPreviewCase.entries.asSequence()
}

enum class ScreenPreviewCase(val fileName: String) {
    PairIdle("pair-idle"),
    PairCameraGranted("pair-camera-granted"),
    PairCameraDenied("pair-camera-denied"),
    PairPasteLink("pair-paste-link"),
    PairInvalidError("pair-invalid-error"),
    ConfirmHttps("confirm-https"),
    ConfirmNonHttps("confirm-non-https"),
    ConfirmClaiming("confirm-claiming"),
    ConfirmRetryableError("confirm-retryable-error"),
    ConfirmError("confirm-error"),
    OnboardingNotifications("onboarding-notifications"),
    OnboardingBattery("onboarding-battery"),
    OnboardingDone("onboarding-done"),
    OnboardingWarning("onboarding-warning"),
    MainShellHome("main-shell-home"),
    MainShellDevices("main-shell-devices"),
    MainShellSettings("main-shell-settings"),
    MainShellSettingsBusy("main-shell-settings-busy"),
    MainShellSignOutError("main-shell-sign-out-error")
}

@Preview(name = "Light", widthDp = 360, heightDp = 800)
@Preview(name = "Dark", widthDp = 360, heightDp = 800, uiMode = Configuration.UI_MODE_NIGHT_YES)
@Composable
internal fun PneumoScreenPreview(@PreviewParameter(ScreenPreviewProvider::class) fixture: ScreenPreviewCase) {
    PneumoTheme { ScreenPreviewContent(fixture) }
}

/** Previews and screenshot tests render the same fixture data. No camera or network is opened. */
@Composable
internal fun ScreenPreviewContent(fixture: ScreenPreviewCase) {
    when (fixture) {
        ScreenPreviewCase.PairIdle, ScreenPreviewCase.PairCameraGranted, ScreenPreviewCase.PairCameraDenied,
        ScreenPreviewCase.PairPasteLink, ScreenPreviewCase.PairInvalidError -> PairPreview(fixture)

        ScreenPreviewCase.ConfirmHttps, ScreenPreviewCase.ConfirmNonHttps,
        ScreenPreviewCase.ConfirmClaiming, ScreenPreviewCase.ConfirmRetryableError,
        ScreenPreviewCase.ConfirmError -> ConfirmPreview(fixture)

        ScreenPreviewCase.OnboardingNotifications, ScreenPreviewCase.OnboardingBattery,
        ScreenPreviewCase.OnboardingDone, ScreenPreviewCase.OnboardingWarning -> OnboardingPreview(fixture)

        else -> ShellPreview(fixture)
    }
}

@Composable
private fun PairPreview(fixture: ScreenPreviewCase) {
    PairScreen(
        state = PairUiState(
            cameraGranted = fixture == ScreenPreviewCase.PairCameraGranted,
            cameraDenied = fixture == ScreenPreviewCase.PairCameraDenied,
            pasteMode = fixture == ScreenPreviewCase.PairPasteLink || fixture == ScreenPreviewCase.PairInvalidError,
            link = "",
            error = if (fixture ==
                ScreenPreviewCase.PairInvalidError
            ) {
                "Invalid pairing link. Make a new code in the web app and try again."
            } else {
                null
            }
        ),
        actions = PairActions({}, {}, {}, {})
    )
}

@Composable
private fun ConfirmPreview(fixture: ScreenPreviewCase) {
    val insecure = fixture == ScreenPreviewCase.ConfirmNonHttps
    val error = when (fixture) {
        ScreenPreviewCase.ConfirmRetryableError -> "Couldn't reach the server. Check your connection and try again."
        ScreenPreviewCase.ConfirmError -> "This code has expired. Make a new one in the web app."
        else -> null
    }
    ConfirmScreen(
        state = ConfirmUiState(
            origin = if (insecure) "http://10.0.2.2:8080" else "https://pneumo.example.com:8443",
            busy = fixture == ScreenPreviewCase.ConfirmClaiming,
            error = error,
            retryable = fixture == ScreenPreviewCase.ConfirmRetryableError,
            showInsecureWarning = insecure
        ),
        onConfirm = {},
        onBack = {}
    )
}

@Composable
private fun OnboardingPreview(fixture: ScreenPreviewCase) {
    val step = when (fixture) {
        ScreenPreviewCase.OnboardingNotifications -> OnboardingStep.Notifications
        ScreenPreviewCase.OnboardingBattery -> OnboardingStep.Battery
        else -> OnboardingStep.Done
    }
    OnboardingScreen(
        step = step,
        warning = if (fixture ==
            ScreenPreviewCase.OnboardingWarning
        ) {
            "Battery optimization is still on. Android may delay pushes."
        } else {
            null
        },
        onAllow = {},
        onSkip = {}
    )
}

@Composable
private fun ShellPreview(fixture: ScreenPreviewCase) {
    val tab = when (fixture) {
        ScreenPreviewCase.MainShellHome -> MainTab.Home
        ScreenPreviewCase.MainShellDevices -> MainTab.Devices
        else -> MainTab.Settings
    }
    MainShell(
        tab = tab,
        state = ShellUiState(
            origin = "https://pneumo.example.com:8443",
            busy = fixture == ScreenPreviewCase.MainShellSettingsBusy,
            error = if (fixture ==
                ScreenPreviewCase.MainShellSignOutError
            ) {
                "Couldn't reach the server. Try signing out again."
            } else {
                null
            }
        ),
        onTab = {},
        onSignOut = {}
    )
}
