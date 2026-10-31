package dev.pneumo.app.ui

import android.Manifest
import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.core.content.ContextCompat
import androidx.core.net.toUri
import dev.pneumo.app.R
import dev.pneumo.app.ui.screens.OnboardingScreen
import dev.pneumo.app.ui.screens.OnboardingStep

@Composable
internal fun PermissionOnboarding(onDone: () -> Unit, error: String?, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    var step by rememberSaveable { mutableStateOf(initialOnboardingStep()) }
    var warningId by rememberSaveable { mutableIntStateOf(0) }
    val notifications = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        warningId = if (granted) 0 else R.string.runtime_notifications_skipped
        step = OnboardingStep.Battery
    }
    val battery = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) {
        val power = context.getSystemService(PowerManager::class.java)
        if (!power.isIgnoringBatteryOptimizations(context.packageName)) {
            warningId = R.string.runtime_battery_skipped
        }
        step = OnboardingStep.Done
    }
    OnboardingScreen(
        step = step,
        warning = error ?: if (warningId == 0) null else stringResource(warningId),
        onAllow = {
            when (step) {
                OnboardingStep.Notifications -> allowNotifications(
                    context = context,
                    request = { notifications.launch(Manifest.permission.POST_NOTIFICATIONS) },
                    onNext = { step = OnboardingStep.Battery }
                )

                OnboardingStep.Battery -> allowBatteryExemption(
                    context = context,
                    request = battery::launch,
                    onNext = { messageId ->
                        if (messageId != 0) warningId = messageId
                        step = OnboardingStep.Done
                    }
                )

                OnboardingStep.Done -> onDone()
            }
        },
        onSkip = {
            when (step) {
                OnboardingStep.Notifications -> {
                    warningId = R.string.runtime_notifications_skipped
                    step = OnboardingStep.Battery
                }

                OnboardingStep.Battery -> {
                    warningId = R.string.runtime_battery_skipped
                    step = OnboardingStep.Done
                }

                OnboardingStep.Done -> onDone()
            }
        },
        modifier = modifier
    )
}

private fun initialOnboardingStep(): OnboardingStep = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
    OnboardingStep.Notifications
} else {
    OnboardingStep.Battery
}

private fun allowNotifications(context: Context, request: () -> Unit, onNext: () -> Unit) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
        ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) !=
        PackageManager.PERMISSION_GRANTED
    ) {
        request()
    } else {
        onNext()
    }
}

// SPEC §14.3 requires this request: sideloaded instant messaging without FCM needs a persistent connection.
@SuppressLint("BatteryLife")
private fun allowBatteryExemption(context: Context, request: (Intent) -> Unit, onNext: (Int) -> Unit) {
    val power = context.getSystemService(PowerManager::class.java)
    if (power.isIgnoringBatteryOptimizations(context.packageName)) {
        onNext(0)
    } else {
        try {
            request(
                Intent(
                    Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    "package:${context.packageName}".toUri()
                )
            )
        } catch (_: ActivityNotFoundException) {
            onNext(R.string.runtime_battery_unavailable)
        }
    }
}
