package dev.pneumo.app.ui.screens

import androidx.annotation.StringRes
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import dev.pneumo.app.R

@Composable
fun OnboardingScreen(
    step: OnboardingStep,
    warning: String?,
    onAllow: () -> Unit,
    onSkip: () -> Unit,
    modifier: Modifier = Modifier
) {
    val content = remember(step) { step.content() }
    ScreenFrame(modifier = modifier) {
        BrandHeader()
        ScreenHeading(
            title = stringResource(content.title),
            body = stringResource(content.body)
        )

        if (warning != null) {
            WarningMessage(stringResource(R.string.onboarding_warning_recovery, warning))
        }

        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            PrimaryButton(
                onClick = onAllow,
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)
            ) {
                Text(stringResource(content.action))
            }
            if (step != OnboardingStep.Done) {
                SecondaryButton(
                    onClick = onSkip,
                    modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)
                ) {
                    Text(stringResource(R.string.onboarding_skip))
                }
            }
        }
    }
}

private data class OnboardingContent(@StringRes val title: Int, @StringRes val body: Int, @StringRes val action: Int)

private fun OnboardingStep.content(): OnboardingContent = when (this) {
    OnboardingStep.Notifications ->
        OnboardingContent(
            title = R.string.onboarding_notifications_title,
            body = R.string.onboarding_notifications_body,
            action = R.string.onboarding_notifications_action
        )

    OnboardingStep.Battery ->
        OnboardingContent(
            title = R.string.onboarding_battery_title,
            body = R.string.onboarding_battery_body,
            action = R.string.onboarding_battery_action
        )

    OnboardingStep.Done ->
        OnboardingContent(
            title = R.string.onboarding_done_title,
            body = R.string.onboarding_done_body,
            action = R.string.onboarding_done_action
        )
}
