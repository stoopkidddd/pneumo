package dev.pneumo.app.notify

import android.Manifest
import android.app.NotificationManager
import android.content.Intent
import android.os.Environment
import androidx.compose.ui.test.junit4.v2.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.core.content.FileProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.work.WorkManager
import dev.pneumo.app.AndroidSmokeApi
import dev.pneumo.app.MainActivity
import dev.pneumo.app.PneumoApp
import dev.pneumo.app.ShareActivity
import dev.pneumo.app.crypto.Base64Url
import dev.pneumo.app.data.SecureStore
import dev.pneumo.app.data.SessionPreferences
import dev.pneumo.app.service.ConnectionService
import dev.pneumo.app.transfer.DownloadState
import dev.pneumo.app.transfer.DownloadTransfers
import java.io.File
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class FileTransferSmokeTest {
    @get:Rule
    val compose = createEmptyComposeRule()

    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private val container = (context.applicationContext as PneumoApp).container
    private val credentials = SecureStore.create(context)
    private val preferences = SessionPreferences.create(context)
    private val manager = context.getSystemService(NotificationManager::class.java)
    private val source = File(context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "Pneumo/share-source.bin")
    private val original = ByteArray(SOURCE_BYTES) { (it % BYTE_MODULUS).toByte() }
    private var downloaded: android.net.Uri? = null
    private var postedPushId: String? = null
    private lateinit var api: AndroidSmokeApi

    @Before
    fun setUp() {
        instrumentation.uiAutomation.grantRuntimePermission(context.packageName, Manifest.permission.POST_NOTIFICATIONS)
        api = AndroidSmokeApi()
        source.parentFile?.mkdirs()
        source.writeBytes(original)
        runBlocking {
            container.database.wipe()
            credentials.save(ByteArray(KEY_BYTES), Base64Url.encode(ByteArray(KEY_BYTES)))
            preferences.saveSession(api.origin, AndroidSmokeApi.DEVICE_ID)
            preferences.completeOnboarding()
        }
    }

    @After
    fun tearDown() {
        WorkManager.getInstance(context).cancelAllWork().result.get()
        postedPushId?.let { PushNotificationGroup.cancelChild(context, it) }
        ConnectionService.stop(context)
        downloaded?.let { context.contentResolver.delete(it, null, null) }
        source.delete()
        runBlocking {
            val session = container.openSession()
            credentials.clear()
            preferences.clearSession()
            if (session != null) session.cache.clear { container.database.wipe() } else container.database.wipe()
        }
        api.close()
    }

    @Test
    fun sharedFileUploadsThenNotificationDownloadsIdenticalBytes() {
        sendSharedFile()
        ActivityScenario.launch(MainActivity::class.java).use {
            compose.waitUntil(TIMEOUT_MS) {
                compose.onAllNodesWithText(source.name).fetchSemanticsNodes().isNotEmpty()
            }
            val pushId = runBlocking {
                val session = requireNotNull(container.openSession())
                val item = session.pushes.list().single()
                postedPushId = item.push.id
                PushNotifier(context, session.deviceId, session.contentKey).accept(
                    item.push.copy(sourceDeviceId = REMOTE_DEVICE)
                )
                item.push.id
            }
            downloadFromNotification(pushId)
            compose.waitUntil(TIMEOUT_MS) {
                compose.onAllNodesWithText("Share").fetchSemanticsNodes().isNotEmpty()
            }
        }
    }

    private fun sendSharedFile() {
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", source)
        val share = Intent(context, ShareActivity::class.java)
            .setAction(Intent.ACTION_SEND)
            .setType("application/octet-stream")
            .putExtra(Intent.EXTRA_STREAM, uri)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        ActivityScenario.launch<ShareActivity>(share).use { scenario ->
            compose.waitUntil(TIMEOUT_MS) {
                compose.onAllNodesWithText("All devices").fetchSemanticsNodes().isNotEmpty()
            }
            compose.onNodeWithText("Send").performClick()
            compose.waitUntil(TIMEOUT_MS) { scenario.state == androidx.lifecycle.Lifecycle.State.DESTROYED }
        }
    }

    private fun downloadFromNotification(pushId: String) {
        compose.waitUntil(TIMEOUT_MS) { manager.activeNotifications.any { it.tag == pushId } }
        val initial = manager.activeNotifications.single { it.tag == pushId }
        initial.notification.actions.single { it.title.toString() == "Download" }.actionIntent.send()
        val done = runBlocking {
            withTimeout(TIMEOUT_MS) {
                DownloadTransfers.observe(context).first { it[pushId] is DownloadState.Done }[pushId]
                    as DownloadState.Done
            }
        }
        downloaded = done.uri
        context.contentResolver.openInputStream(done.uri)!!.use { input ->
            assertArrayEquals(original, input.readBytes())
        }
        compose.waitUntil(TIMEOUT_MS) {
            manager.activeNotifications.singleOrNull { it.tag == pushId }?.notification?.actions
                ?.map { it.title.toString() } == listOf("Open", "Share")
        }
        assertEquals(initial.id, manager.activeNotifications.single { it.tag == pushId }.id)
    }

    private companion object {
        const val TIMEOUT_MS = 30_000L
        const val SOURCE_BYTES = 65_537
        const val BYTE_MODULUS = 251
        const val KEY_BYTES = 32
        const val REMOTE_DEVICE = "0192e7ce-7c00-7000-8000-000000000002"
    }
}
