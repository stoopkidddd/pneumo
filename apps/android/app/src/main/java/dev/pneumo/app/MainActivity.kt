package dev.pneumo.app

import android.app.NotificationManager
import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import dev.pneumo.app.notify.PushNotificationGroup
import dev.pneumo.app.notify.PushNotifier
import dev.pneumo.app.ui.NotificationUiState
import dev.pneumo.app.ui.PairingViewModel
import dev.pneumo.app.ui.PneumoNavHost
import dev.pneumo.app.ui.theme.PneumoTheme

class MainActivity : ComponentActivity() {
    internal val pairingViewModel: PairingViewModel by lazy {
        ViewModelProvider(
            this,
            viewModelFactory {
                initializer { PairingViewModel((application as PneumoApp).container.pairingRepository) }
            }
        )[PairingViewModel::class.java]
    }

    private var notificationPushId by mutableStateOf<String?>(null)
    private var notificationNavigationId by mutableLongStateOf(0L)
    private var notificationsEnabled by mutableStateOf(true)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        notificationPushId = savedInstanceState?.getString(STATE_PUSH_ID)
        notificationNavigationId = savedInstanceState?.getLong(STATE_NAVIGATION_ID) ?: 0L
        notificationsEnabled = arePushNotificationsEnabled()
        if (savedInstanceState == null && intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY == 0) {
            handleIncomingIntent(intent)
        } else {
            sanitizeIntent()
        }
        setContent {
            PneumoTheme {
                PneumoNavHost(
                    viewModel = pairingViewModel,
                    connectionState = (application as PneumoApp).container.connectionState,
                    notifications = NotificationUiState(
                        notificationPushId,
                        notificationNavigationId,
                        notificationsEnabled
                    )
                )
            }
        }
    }

    override fun onResume() {
        super.onResume()
        notificationsEnabled = arePushNotificationsEnabled()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putString(STATE_PUSH_ID, notificationPushId)
        outState.putLong(STATE_NAVIGATION_ID, notificationNavigationId)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIncomingIntent(intent)
    }

    private fun handleIncomingIntent(incoming: Intent) {
        if (incoming.action == Intent.ACTION_VIEW) {
            pairingViewModel.openLink(incoming.dataString.orEmpty())
        }
        incoming.getStringExtra(EXTRA_PUSH_ID)?.takeIf(String::isNotBlank)?.let { pushId ->
            PushNotificationGroup.cancelChild(this, pushId)
            notificationPushId = pushId
            notificationNavigationId += 1
        }
        sanitizeIntent()
    }

    private fun sanitizeIntent() {
        // Preserve launch identity, but never replay a consumed VIEW action, URI or notification target.
        setIntent(
            Intent(intent).apply {
                if (action == Intent.ACTION_VIEW) {
                    action = Intent.ACTION_MAIN
                    data = null
                }
                removeExtra(EXTRA_PUSH_ID)
            }
        )
    }

    private fun arePushNotificationsEnabled(): Boolean {
        val manager = getSystemService(NotificationManager::class.java)
        if (!manager.areNotificationsEnabled()) return false
        val pushChannel = manager.getNotificationChannel(PushNotifier.CHANNEL_ID)
        return pushChannel == null || pushChannel.importance != NotificationManager.IMPORTANCE_NONE
    }

    companion object {
        const val EXTRA_PUSH_ID = "pushId"

        private const val STATE_PUSH_ID = "notificationPushId"
        private const val STATE_NAVIGATION_ID = "notificationNavigationId"
    }
}
