package dev.pneumo.app.notify

import android.Manifest
import android.app.Activity
import android.app.Instrumentation.ActivityResult
import android.app.Notification
import android.app.NotificationManager
import android.content.ClipboardManager
import android.content.Intent
import android.net.Uri
import android.os.SystemClock
import androidx.compose.ui.test.ComposeTimeoutException
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.espresso.intent.Intents
import androidx.test.espresso.intent.Intents.intended
import androidx.test.espresso.intent.Intents.intending
import androidx.test.espresso.intent.matcher.IntentMatchers.hasAction
import androidx.test.espresso.intent.matcher.IntentMatchers.hasCategories
import androidx.test.espresso.intent.matcher.IntentMatchers.hasData
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import androidx.work.WorkManager
import dev.pneumo.app.MainActivity
import dev.pneumo.app.PneumoApp
import dev.pneumo.app.data.SecureStore
import dev.pneumo.app.data.SessionPreferences
import dev.pneumo.app.data.SyncPreferences
import dev.pneumo.app.service.ConnectionService
import dev.pneumo.app.transfer.DownloadState
import dev.pneumo.app.transfer.DownloadTransfers
import java.io.File
import java.net.URI
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import org.hamcrest.Matchers.allOf
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class RealServerSmokeTest {
    @get:Rule(order = 0)
    val notificationPermission: GrantPermissionRule =
        GrantPermissionRule.grant(Manifest.permission.POST_NOTIFICATIONS)

    @get:Rule(order = 1)
    val compose = createEmptyComposeRule()

    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private val container = (context.applicationContext as PneumoApp).container
    private val notificationManager = context.getSystemService(NotificationManager::class.java)
    private val device = UiDevice.getInstance(instrumentation)

    private var started = false
    private var localStateReset = false
    private var downloaded: Uri? = null
    private var coordinator: HarnessCoordinator? = null
    private var sender: RealServerSender? = null

    @After
    fun tearDown() {
        if (!started) return

        var clean = true
        try {
            WorkManager.getInstance(context).cancelAllWork().result.get()
        } catch (_: Exception) {
            clean = false
        }
        downloaded?.let { uri ->
            try {
                context.contentResolver.delete(uri, null, null)
            } catch (_: Exception) {
                clean = false
            }
        }
        downloaded = null
        try {
            notificationManager.cancelAll()
            ConnectionService.stop(context)
        } catch (_: Exception) {
            clean = false
        }

        runBlocking { if (!clearStoredSessions()) clean = false }
        try {
            coordinator?.close()
        } catch (_: Exception) {
            clean = false
        } finally {
            coordinator = null
        }
        if (!clean) throw AssertionError("Real-server smoke cleanup failed")
    }

    private suspend fun clearStoredSessions(): Boolean {
        var clean = true
        try {
            if (sender?.cleanUp() == false) clean = false
        } catch (_: Exception) {
            clean = false
        } finally {
            sender = null
        }
        if (localStateReset) {
            try {
                container.pairingRepository.abandonPairing()
                if (container.openSession() != null) {
                    container.pairingRepository.signOut()
                } else {
                    container.pairingRepository.revoke()
                }
            } catch (_: Exception) {
                clean = false
                runCatching { container.pairingRepository.revoke() }
            }
        }
        try {
            SecureStore.create(context).clear()
            clearSessionPreferences()
            SyncPreferences.create(context).clear()
            container.database.wipe()
        } catch (_: Exception) {
            clean = false
        }
        return clean
    }

    @Test
    fun managedDeviceExercisesRealServerEndToEnd() {
        val harnessOrigin = InstrumentationRegistry.getArguments().getString(HARNESS_ARGUMENT)
        assumeTrue("Real-server harness is not configured", !harnessOrigin.isNullOrBlank())

        val config = readPrivateConfig()
        val activeCoordinator = try {
            HarnessCoordinator(checkNotNull(harnessOrigin))
        } catch (_: Exception) {
            throw AssertionError("Harness coordinator URL is invalid")
        }
        coordinator = activeCoordinator
        resetLocalState()
        sender = try {
            RealServerSender(
                origin = config.sender.url,
                deviceId = config.sender.deviceId,
                token = config.sender.token,
                encodedMasterKey = config.sender.mk
            )
        } catch (_: Throwable) {
            throw AssertionError("Sender credentials are invalid")
        }

        val scenario = launchPairing(config.pairUri)
        scenario.use {
            exercisePairingAndOnboarding(config.sender.url)
            activeCoordinator.stage(STAGE_PAIR)
            assertConnected()
            activeCoordinator.stage(STAGE_CONNECTED)

            compose.onNodeWithText(HOME).performClick()
            exerciseNoteCopy(it, activeCoordinator)
            exerciseLinkOpen(activeCoordinator)
            val fileActions = exerciseFileDownload(it, activeCoordinator)
            exerciseSendBack(config.sendBackBody, activeCoordinator)
            exerciseBackgroundDelivery(activeCoordinator)
            assertTrue(
                "Downloaded file notification actions were not Open and Share: $fileActions",
                fileActions == listOf(OPEN, SHARE)
            )
        }
    }

    private fun exercisePairingAndOnboarding(senderOrigin: String) {
        val authority = try {
            URI(senderOrigin).rawAuthority
        } catch (_: Exception) {
            null
        } ?: throw AssertionError("Sender origin is invalid")
        val confirmation = "Pair with $authority?"
        compose.waitUntil(UI_TIMEOUT_MS) {
            compose.onAllNodesWithText(confirmation).fetchSemanticsNodes().isNotEmpty()
        }
        assertTrue(
            "Pairing confirmation did not show the sender host",
            compose.onAllNodesWithText(confirmation).fetchSemanticsNodes().isNotEmpty()
        )
        compose.onNodeWithText(PAIR_ACTION).performClick()

        compose.waitUntil(PAIR_TIMEOUT_MS) {
            compose.onAllNodesWithText(NOTIFICATION_ONBOARDING).fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNode(hasText(NOTIFICATION_ONBOARDING) and hasClickAction()).performClick()
        compose.waitUntil(UI_TIMEOUT_MS) {
            compose.onAllNodesWithText(BATTERY_ONBOARDING).fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText(SKIP).performClick()
        compose.waitUntil(UI_TIMEOUT_MS) {
            compose.onAllNodesWithText(ONBOARDING_DONE).fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText(OPEN_PNEUMO).performClick()
        compose.waitUntil(UI_TIMEOUT_MS) {
            compose.onAllNodesWithText(HOME).fetchSemanticsNodes().isNotEmpty()
        }
    }

    private fun assertConnected() {
        compose.onNodeWithText(SETTINGS).performClick()
        compose.waitUntil(CONNECTION_TIMEOUT_MS) {
            compose.onAllNodesWithText(CONNECTED).fetchSemanticsNodes().isNotEmpty()
        }
        assertTrue(
            "Settings did not show Connected",
            compose.onAllNodesWithText(CONNECTED).fetchSemanticsNodes().isNotEmpty()
        )
    }

    private fun exerciseNoteCopy(scenario: ActivityScenario<MainActivity>, activeCoordinator: HarnessCoordinator) {
        val pushId = runBlocking { requireSender().sendNote(NOTE_TITLE, NOTE_BODY) }
        waitForNotification(pushId, NOTE_TITLE)
        performNotificationAction(pushId, NOTE_TITLE, COPY)
        compose.waitUntil(UI_TIMEOUT_MS) { notification(pushId) == null }
        focusMainActivity(scenario)
        var clipboardText: String? = null
        scenario.onActivity { activity ->
            val clipboard = activity.getSystemService(ClipboardManager::class.java)
            clipboardText = clipboard.primaryClip
                ?.takeIf { it.itemCount == 1 }
                ?.getItemAt(0)
                ?.coerceToText(activity)
                ?.toString()
        }
        assertTrue("Notification Copy did not preserve the exact note body", clipboardText == NOTE_BODY)
        activeCoordinator.stage(STAGE_COPY)
    }

    private fun exerciseLinkOpen(activeCoordinator: HarnessCoordinator) {
        val pushId = runBlocking { requireSender().sendLink(LINK_TITLE, LINK_URL) }
        val status = waitForNotification(pushId, LINK_TITLE)
        val actions = status.notification.actions?.map { it.title.toString() }.orEmpty()
        assertTrue("Link notification actions were not Open and Copy", actions == listOf(OPEN, COPY))

        Intents.init()
        try {
            intending(allOf(hasAction(Intent.ACTION_VIEW), hasData(LINK_URL)))
                .respondWith(ActivityResult(Activity.RESULT_OK, null))
            performNotificationAction(pushId, LINK_TITLE, OPEN)
            compose.waitUntil(UI_TIMEOUT_MS) { notification(pushId) == null }
            intended(
                allOf(
                    hasAction(Intent.ACTION_VIEW),
                    hasData(LINK_URL),
                    hasCategories(setOf(Intent.CATEGORY_BROWSABLE))
                )
            )
        } finally {
            Intents.release()
        }
        activeCoordinator.stage(STAGE_LINK)
    }

    private fun exerciseFileDownload(
        scenario: ActivityScenario<MainActivity>,
        activeCoordinator: HarnessCoordinator
    ): List<String> {
        val plaintext = ByteArray(FILE_BYTES).also(SecureRandom()::nextBytes)
        val expectedDigest = MessageDigest.getInstance(SHA_256).digest(plaintext)
        val pushId = try {
            runBlocking { requireSender().sendFile(FILE_NAME, FILE_MIME, plaintext) }
        } finally {
            plaintext.fill(0)
        }

        waitForNotification(pushId, FILE_NAME)
        performNotificationAction(pushId, FILE_NAME, DOWNLOAD)
        focusMainActivity(scenario)
        val done = try {
            runBlocking {
                withTimeout(FILE_TIMEOUT_MS) {
                    DownloadTransfers.observe(context).first { states -> states[pushId] is DownloadState.Done }[pushId]
                        as DownloadState.Done
                }
            }
        } catch (_: Exception) {
            throw AssertionError("File download did not complete")
        }
        downloaded = done.uri

        assertDownloadedFile(done.uri, expectedDigest)

        activeCoordinator.stage("file SHA-256 verified")
        try {
            compose.waitUntil(UI_TIMEOUT_MS) {
                notification(pushId)?.notification?.actions?.map { it.title.toString() } == listOf(OPEN, SHARE)
            }
        } catch (_: ComposeTimeoutException) {
            // Retain this failure, but also exercise the independent send-back and Doze checks.
            activeCoordinator.stage("file notification missing Open Share")
        }
        return notification(pushId)?.notification?.actions?.map { it.title.toString() }.orEmpty()
    }

    private fun assertDownloadedFile(uri: Uri, expectedDigest: ByteArray) {
        val digest = MessageDigest.getInstance(SHA_256)
        var size = 0L
        try {
            val input = checkNotNull(context.contentResolver.openInputStream(uri))
            input.use {
                val buffer = ByteArray(DIGEST_BUFFER_BYTES)
                var count = it.read(buffer)
                while (count >= 0) {
                    digest.update(buffer, 0, count)
                    size += count.toLong()
                    count = it.read(buffer)
                }
            }
        } catch (_: Exception) {
            throw AssertionError("Downloaded MediaStore content could not be read")
        }
        assertEquals("Downloaded file size differed", FILE_BYTES.toLong(), size)
        assertArrayEquals("Downloaded file digest differed", expectedDigest, digest.digest())
    }

    private fun exerciseSendBack(body: String, activeCoordinator: HarnessCoordinator) {
        compose.onNode(hasSetTextAction()).performTextInput(body)
        activeCoordinator.sendBackReady()
        compose.onNodeWithText(SEND).performClick()
        activeCoordinator.sendBackReceived()
        activeCoordinator.stage(STAGE_SEND_BACK)
    }

    private fun exerciseBackgroundDelivery(activeCoordinator: HarnessCoordinator) {
        device.pressHome()
        val title = activeCoordinator.doze()
        assertTrue("Doze coordinator returned an unexpected title", title == BACKGROUND_TITLE)
        compose.waitUntil(BACKGROUND_TIMEOUT_MS) {
            notificationManager.activeNotifications.any { status ->
                status.notification.extras.getCharSequence(Notification.EXTRA_TITLE)?.toString() == BACKGROUND_TITLE
            }
        }
        assertTrue(
            "Background notification was not delivered",
            notificationManager.activeNotifications.any { status ->
                status.notification.extras.getCharSequence(Notification.EXTRA_TITLE)?.toString() == BACKGROUND_TITLE
            }
        )
        activeCoordinator.stage(STAGE_BACKGROUND)
    }

    private fun waitForNotification(pushId: String, title: String): android.service.notification.StatusBarNotification {
        compose.waitUntil(NOTIFICATION_TIMEOUT_MS) {
            notification(pushId)?.notification?.extras?.getCharSequence(Notification.EXTRA_TITLE)?.toString() == title
        }
        return notification(pushId) ?: throw AssertionError("Expected notification was not posted")
    }

    private fun notification(pushId: String): android.service.notification.StatusBarNotification? =
        notificationManager.activeNotifications.singleOrNull { it.tag == pushId }

    private fun performNotificationAction(pushId: String, title: String, action: String) {
        val shadeOpened = try {
            device.openNotification()
        } catch (_: Exception) {
            false
        }
        if (shadeOpened) {
            val visibleTitle = device.wait(Until.findObject(By.pkg(SYSTEM_UI_PACKAGE).text(title)), SHADE_TIMEOUT_MS)
            if (visibleTitle != null) {
                val actionButton = device.wait(
                    Until.findObject(By.pkg(SYSTEM_UI_PACKAGE).text(action)),
                    SHADE_ACTION_TIMEOUT_MS
                )
                if (actionButton == null) {
                    device.pressBack()
                    throw AssertionError("Interactive notification action was unavailable")
                }
                actionButton.click()
                device.waitForIdle()
                coordinator?.stage("notification shade $action")
                return
            }
            if (device.currentPackageName == SYSTEM_UI_PACKAGE) device.pressBack()
        }

        val fallback = checkNotNull(
            notification(pushId)?.takeIf { status ->
                status.notification.extras.getCharSequence(Notification.EXTRA_TITLE)?.toString() == title
            }
        ) { "Expected notification action was unavailable" }
        val pendingIntent = checkNotNull(
            fallback.notification.actions
                ?.singleOrNull { it.title.toString() == action }
                ?.actionIntent
        ) { "Expected notification action was unavailable" }
        try {
            pendingIntent.send()
            instrumentation.waitForIdleSync()
            coordinator?.stage("ATD PendingIntent $action")
        } catch (_: Exception) {
            throw AssertionError("Notification action could not be invoked")
        }
    }

    private fun focusMainActivity(scenario: ActivityScenario<MainActivity>) {
        // ATD has no interactive shade; a blind Back would finish MainActivity.
        if (device.currentPackageName == SYSTEM_UI_PACKAGE) device.pressBack()
        scenario.moveToState(Lifecycle.State.RESUMED)
        instrumentation.waitForIdleSync()
    }

    private fun launchPairing(pairUri: String): ActivityScenario<MainActivity> {
        var scenario: ActivityScenario<MainActivity>? = null
        val deepLink = Intent(Intent.ACTION_VIEW, Uri.parse(pairUri))
            .addCategory(Intent.CATEGORY_BROWSABLE)
        try {
            scenario = ActivityScenario.launch(MainActivity::class.java)
            scenario.onActivity { activity ->
                instrumentation.callActivityOnNewIntent(activity, deepLink)
            }
            return scenario
        } catch (_: Exception) {
            scenario?.close()
            throw AssertionError("Pairing link could not be delivered")
        } finally {
            deepLink.data = null
        }
    }

    private fun readPrivateConfig(): HarnessConfig {
        val file = File(context.filesDir, CONFIG_FILE)
        val deadline = SystemClock.elapsedRealtime() + CONFIG_TIMEOUT_MS
        while (!file.isFile && SystemClock.elapsedRealtime() < deadline) {
            SystemClock.sleep(POLL_INTERVAL_MS)
        }
        assertTrue("Private harness config was not provided", file.isFile)
        started = true

        val raw = try {
            file.readText()
        } catch (_: Exception) {
            file.delete()
            throw AssertionError("Private harness config could not be read")
        }
        assertTrue("Private harness config could not be consumed", file.delete())
        return try {
            CONFIG_JSON.decodeFromString(HarnessConfig.serializer(), raw)
        } catch (_: Exception) {
            throw AssertionError("Private harness config was invalid")
        }
    }

    private fun resetLocalState() {
        try {
            WorkManager.getInstance(context).cancelAllWork().result.get()
            notificationManager.cancelAll()
            ConnectionService.stop(context)
            runBlocking {
                SecureStore.create(context).clear()
                clearSessionPreferences()
                SyncPreferences.create(context).clear()
                container.database.wipe()
            }
            localStateReset = true
        } catch (_: Exception) {
            throw AssertionError("Managed-device state could not be reset")
        }
    }

    @Suppress("UNCHECKED_CAST")
    private suspend fun clearSessionPreferences() {
        // clearSession deliberately preserves onboarding; this test must exercise it again.
        val preferences = SessionPreferences.create(context)
        val field = SessionPreferences::class.java.getDeclaredField("dataStore")
        field.isAccessible = true
        val store = field.get(preferences) as DataStore<Preferences>
        store.edit { values -> values.clear() }
    }

    private fun requireSender(): RealServerSender = sender ?: throw AssertionError("Sender was not initialized")

    private companion object {
        val CONFIG_JSON = Json { ignoreUnknownKeys = false }

        const val HARNESS_ARGUMENT = "pneumoHarness"
        const val CONFIG_FILE = "pneumo-e2e.json"
        const val HOME = "Home"
        const val SETTINGS = "Settings"
        const val CONNECTED = "Connected"
        const val PAIR_ACTION = "Pair with server"
        const val NOTIFICATION_ONBOARDING = "Allow notifications"
        const val BATTERY_ONBOARDING = "Keep pushes instant"
        const val SKIP = "Skip for now"
        const val ONBOARDING_DONE = "You’re ready"
        const val OPEN_PNEUMO = "Open Pneumo"
        const val NOTE_TITLE = "E2E encrypted note"
        const val NOTE_BODY = "Managed Android copied this encrypted note"
        const val LINK_TITLE = "E2E encrypted link"
        const val LINK_URL = "https://example.com/pneumo-e2e"
        const val FILE_NAME = "pneumo-e2e.bin"
        const val FILE_MIME = "application/octet-stream"
        const val COPY = "Copy"
        const val OPEN = "Open"
        const val DOWNLOAD = "Download"
        const val SHARE = "Share"
        const val SEND = "Send"
        const val BACKGROUND_TITLE = "E2E background note"
        const val SHA_256 = "SHA-256"
        const val STAGE_PAIR = "pair"
        const val STAGE_CONNECTED = "connected"
        const val STAGE_COPY = "copy"
        const val STAGE_LINK = "link"
        const val STAGE_SEND_BACK = "sendback"
        const val STAGE_BACKGROUND = "background"

        const val FILE_BYTES = 1_048_576
        const val DIGEST_BUFFER_BYTES = 16_384
        const val POLL_INTERVAL_MS = 200L
        const val SYSTEM_UI_PACKAGE = "com.android.systemui"
        const val SHADE_ACTION_TIMEOUT_MS = 2_000L
        const val SHADE_TIMEOUT_MS = 5_000L
        const val UI_TIMEOUT_MS = 15_000L
        const val CONNECTION_TIMEOUT_MS = 30_000L
        const val NOTIFICATION_TIMEOUT_MS = 30_000L
        const val BACKGROUND_TIMEOUT_MS = 30_000L
        const val CONFIG_TIMEOUT_MS = 60_000L
        const val PAIR_TIMEOUT_MS = 60_000L
        const val FILE_TIMEOUT_MS = 90_000L
    }
}

@Serializable
private class HarnessConfig(val pairUri: String, val sender: HarnessSender, val sendBackBody: String)

@Serializable
private class HarnessSender(val url: String, val deviceId: String, val token: String, val mk: String)

@Serializable
private class DozeResponse(val title: String)

private class HarnessCoordinator(origin: String) {
    private val root: HttpUrl = origin.toHttpUrl()
    private val client = OkHttpClient.Builder()
        .readTimeout(120, TimeUnit.SECONDS)
        .build()

    fun stage(name: String) {
        val url = root.newBuilder().addPathSegment("stage").addQueryParameter("name", name).build()
        execute(url, HTTP_NO_CONTENT)
    }

    fun sendBackReady() {
        execute(root.newBuilder().addPathSegment("send-back-ready").build(), HTTP_NO_CONTENT)
    }

    fun sendBackReceived() {
        execute(root.newBuilder().addPathSegment("send-back-received").build(), HTTP_NO_CONTENT)
    }

    fun doze(): String {
        val body = execute(root.newBuilder().addPathSegment("doze").build(), HTTP_OK)
        return try {
            Json.decodeFromString(DozeResponse.serializer(), body).title
        } catch (_: Exception) {
            throw AssertionError("Doze coordinator response was invalid")
        }
    }

    fun close() {
        client.dispatcher.executorService.shutdown()
        client.connectionPool.evictAll()
    }

    private fun execute(url: HttpUrl, expectedStatus: Int): String = try {
        client.newCall(Request.Builder().url(url).get().build()).execute().use { response ->
            if (response.code != expectedStatus) throw HarnessResponseException()
            response.body?.string().orEmpty()
        }
    } catch (failure: AssertionError) {
        throw failure
    } catch (_: Exception) {
        throw AssertionError("Harness coordinator request failed")
    }

    private class HarnessResponseException : Exception()

    private companion object {
        const val HTTP_OK = 200
        const val HTTP_NO_CONTENT = 204
    }
}
