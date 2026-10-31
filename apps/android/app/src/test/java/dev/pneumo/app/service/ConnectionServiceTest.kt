package dev.pneumo.app.service

import android.app.Application
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Looper
import androidx.test.core.app.ApplicationProvider
import dev.pneumo.app.crypto.Base64Url
import dev.pneumo.app.data.CredentialStore
import dev.pneumo.app.data.PairingApiFactory
import dev.pneumo.app.data.PairingRepository
import dev.pneumo.app.data.SecureStore
import dev.pneumo.app.data.SessionLifecycle
import dev.pneumo.app.data.SessionMetadata
import dev.pneumo.app.data.SessionStore
import dev.pneumo.app.net.AccountApi
import dev.pneumo.app.net.DeviceApi
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
@OptIn(ExperimentalCoroutinesApi::class)
class ConnectionServiceTest {
    private val context = ApplicationProvider.getApplicationContext<Application>()

    @Test
    fun bootDoesNotStartWhenUnpaired() = runTest {
        val receiver = BootReceiver({ repository(paired = false) }, this)
        context.registerReceiver(receiver, IntentFilter(Intent.ACTION_BOOT_COMPLETED), Context.RECEIVER_NOT_EXPORTED)
        try {
            context.sendBroadcast(Intent(Intent.ACTION_BOOT_COMPLETED))
            shadowOf(Looper.getMainLooper()).idle()
            runCurrent()
            assertNull(shadowOf(context).nextStartedService)
        } finally {
            context.unregisterReceiver(receiver)
        }
    }

    @Test
    fun bootAndPackageReplacementStartForegroundConnectionWhenPaired() = runTest {
        val receiver = BootReceiver({ repository(paired = true) }, this)
        val filter = IntentFilter(Intent.ACTION_BOOT_COMPLETED).apply { addAction(Intent.ACTION_MY_PACKAGE_REPLACED) }
        context.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
        try {
            for (action in listOf(Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED)) {
                context.sendBroadcast(Intent(action))
                shadowOf(Looper.getMainLooper()).idle()
                runCurrent()
                val started = shadowOf(context).nextStartedService
                assertEquals(ConnectionService::class.java.name, started.component?.className)
            }
        } finally {
            context.unregisterReceiver(receiver)
        }
    }

    @Test
    fun foregroundChannelIsSilentMinimumImportanceAndOngoing() {
        val controller = Robolectric.buildService(ConnectionService::class.java).create()
        try {
            val service = controller.get()
            val manager = context.getSystemService(NotificationManager::class.java)
            val channel = manager.getNotificationChannel(ConnectionService.CHANNEL_ID)
            assertEquals(NotificationManager.IMPORTANCE_MIN, channel.importance)
            assertNull(channel.sound)
            val notification = shadowOf(service).lastForegroundNotification
            assertEquals(ConnectionService.CHANNEL_ID, notification.channelId)
            assertEquals(
                android.app.Notification.FLAG_ONGOING_EVENT,
                notification.flags and android.app.Notification.FLAG_ONGOING_EVENT
            )
            val open = shadowOf(notification.contentIntent).savedIntent
            assertEquals(dev.pneumo.app.MainActivity::class.java.name, open.component?.className)
        } finally {
            controller.destroy()
        }
    }

    private fun repository(paired: Boolean): PairingRepository = PairingRepository(
        apiFactory = object : PairingApiFactory {
            override fun account(origin: String, bearerToken: String?): AccountApi = error("Unexpected network request")

            override fun devices(origin: String, bearerToken: String): DeviceApi = error("Unexpected network request")
        },
        credentialStore = object : CredentialStore {
            override suspend fun read(): SecureStore.Credentials? = if (paired) {
                SecureStore.Credentials(ByteArray(KEY_BYTES), Base64Url.encode(ByteArray(KEY_BYTES)))
            } else {
                null
            }

            override suspend fun save(masterKey: ByteArray, token: String): Unit = error("Unexpected save")

            override suspend fun clear(): Unit = error("Unexpected clear")
        },
        sessionStore = object : SessionStore {
            override suspend fun read(): SessionMetadata = if (paired) {
                SessionMetadata("https://pneumo.example.com", DEVICE_ID, true)
            } else {
                SessionMetadata(null, null, false)
            }

            override suspend fun saveSession(origin: String, deviceId: String): Unit = error("Unexpected save")

            override suspend fun completeOnboarding(): Unit = error("Unexpected onboarding")

            override suspend fun clearSession(): Unit = error("Unexpected clear")
        },
        lifecycle = object : SessionLifecycle {
            override suspend fun claimed(createdAt: String): Unit = error("Unexpected claim")

            override fun paired() {
                ConnectionService.start(context)
            }

            override suspend fun cleared(): Unit = error("Unexpected clear")
        },
        deviceName = { "Test phone" }
    )

    private companion object {
        const val KEY_BYTES = 32
        const val DEVICE_ID = "0192e7ce-7c00-7000-8000-000000000001"
    }
}
