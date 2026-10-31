package dev.pneumo.app.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import dev.pneumo.app.MainActivity
import dev.pneumo.app.PneumoApp
import dev.pneumo.app.R
import dev.pneumo.app.data.SessionPreferences
import dev.pneumo.app.net.ws.ConnectionState
import java.net.URI
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

class ConnectionService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val manager by lazy { getSystemService(NotificationManager::class.java) }
    private var host = ""

    override fun onCreate() {
        super.onCreate()
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, getString(R.string.connection_channel), NotificationManager.IMPORTANCE_MIN)
                .apply {
                    setSound(null, null)
                    enableVibration(false)
                    setShowBadge(false)
                }
        )
        showForeground(notification(ConnectionState.Reconnecting, ""))
        val container = (application as PneumoApp).container
        scope.launch {
            val origin = SessionPreferences.create(this@ConnectionService).read().origin
            host = origin?.let { URI(it).rawAuthority }.orEmpty()
            container.connectionState.collect { state ->
                showForeground(notification(state, host))
            }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val container = (application as PneumoApp).container
        showForeground(notification(container.connectionState.value, host))
        container.connect(scope)
        return START_STICKY
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun showForeground(notification: Notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun notification(state: ConnectionState, host: String): Notification {
        val text = when (state) {
            ConnectionState.Connected -> getString(R.string.connection_connected_host, host)
            ConnectionState.Reconnecting -> getString(R.string.connection_reconnecting)
            ConnectionState.Offline -> getString(R.string.connection_offline)
        }
        val openApp = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        return Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(text)
            .setContentIntent(openApp)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(Notification.CATEGORY_SERVICE)
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .build()
    }

    companion object {
        const val CHANNEL_ID = "connection"
        private const val NOTIFICATION_ID = 1

        internal fun start(context: Context) {
            context.startForegroundService(Intent(context, ConnectionService::class.java))
        }

        internal fun stop(context: Context) {
            context.stopService(Intent(context, ConnectionService::class.java))
        }
    }
}
