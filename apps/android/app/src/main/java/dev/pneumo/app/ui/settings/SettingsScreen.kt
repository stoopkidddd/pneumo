package dev.pneumo.app.ui.settings

import android.annotation.SuppressLint
import android.app.NotificationManager
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.os.PowerManager
import android.provider.Settings as AndroidSettings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.core.net.toUri
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import dev.pneumo.app.BuildConfig
import dev.pneumo.app.R
import dev.pneumo.app.net.ws.ConnectionState
import dev.pneumo.app.notify.PushNotifier
import dev.pneumo.app.ui.screens.ConnectionStatus
import dev.pneumo.app.ui.screens.originAuthority

/** Session-owned values. Permission state is read in [SettingsRoute] whenever the app resumes. */
data class SettingsHostState(
    val origin: String,
    val connection: ConnectionState,
    val signOutBusy: Boolean,
    val signOutError: String?
)

internal data class SettingsUiState(
    val authority: String,
    val connection: ConnectionState,
    val notificationsEnabled: Boolean,
    val batteryExempt: Boolean,
    val versionName: String,
    val signOutBusy: Boolean = false,
    val signOutError: String? = null,
    val deliveryError: String? = null
)

internal data class SettingsActions(
    val onOpenNotificationSettings: () -> Unit,
    val onRequestBatteryExemption: () -> Unit,
    val onSignOut: () -> Unit
) {
    companion object {
        val None = SettingsActions({}, {}, {})
    }
}

@Composable
fun SettingsRoute(state: SettingsHostState, onSignOut: () -> Unit, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    var notificationsEnabled by remember { mutableStateOf(arePushNotificationsEnabled(context)) }
    var batteryExempt by remember { mutableStateOf(isBatteryExempt(context)) }
    var batteryUnavailable by remember { mutableStateOf(false) }
    val batteryRequest =
        rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) {
            batteryExempt = isBatteryExempt(context)
            if (batteryExempt) batteryUnavailable = false
        }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) {
        notificationsEnabled = arePushNotificationsEnabled(context)
        batteryExempt = isBatteryExempt(context)
        if (batteryExempt) batteryUnavailable = false
    }
    SettingsScreen(
        state =
            SettingsUiState(
                authority = remember(state.origin) { originAuthority(state.origin) },
                connection = state.connection,
                notificationsEnabled = notificationsEnabled,
                batteryExempt = batteryExempt,
                versionName = BuildConfig.VERSION_NAME,
                signOutBusy = state.signOutBusy,
                signOutError = state.signOutError,
                deliveryError = if (batteryUnavailable) stringResource(R.string.runtime_battery_unavailable) else null
            ),
        actions =
            SettingsActions(
                onOpenNotificationSettings = {
                    context.startActivity(
                        Intent(AndroidSettings.ACTION_APP_NOTIFICATION_SETTINGS)
                            .putExtra(AndroidSettings.EXTRA_APP_PACKAGE, context.packageName)
                    )
                },
                onRequestBatteryExemption = {
                    requestBatteryExemption(
                        context = context,
                        request = batteryRequest::launch,
                        unavailable = {
                            batteryUnavailable = true
                        }
                    )
                },
                onSignOut = onSignOut
            ),
        modifier = modifier
    )
}

@Composable
internal fun SettingsScreen(state: SettingsUiState, actions: SettingsActions, modifier: Modifier = Modifier) {
    Column(
        modifier = modifier.fillMaxSize().verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(24.dp)
    ) {
        Text(text = stringResource(R.string.settings_title), style = MaterialTheme.typography.headlineMedium)
        ConnectionStatus(state.connection)
        PermissionsSettingsSection(state, actions)
        AboutSettingsSection(state)
        SignOutSettingsSection(state, actions.onSignOut)
    }
}

internal fun arePushNotificationsEnabled(context: Context): Boolean {
    val manager = context.getSystemService(NotificationManager::class.java)
    if (!manager.areNotificationsEnabled()) return false
    val pushChannel = manager.getNotificationChannel(PushNotifier.CHANNEL_ID)
    return pushChannel == null || pushChannel.importance != NotificationManager.IMPORTANCE_NONE
}

private fun isBatteryExempt(context: Context): Boolean =
    context.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(context.packageName)

// SPEC §14.3 requires this request: sideloaded messaging without FCM needs a persistent connection.
@SuppressLint("BatteryLife")
private fun requestBatteryExemption(context: Context, request: (Intent) -> Unit, unavailable: () -> Unit) {
    if (isBatteryExempt(context)) return
    try {
        request(
            Intent(
                AndroidSettings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                "package:${context.packageName}".toUri()
            )
        )
    } catch (_: ActivityNotFoundException) {
        unavailable()
    }
}
