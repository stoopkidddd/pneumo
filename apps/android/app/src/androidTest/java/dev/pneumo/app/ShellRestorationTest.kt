package dev.pneumo.app

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.core.net.toUri
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.pneumo.app.crypto.Base64Url
import dev.pneumo.app.data.SecureStore
import dev.pneumo.app.data.SessionPreferences
import dev.pneumo.app.service.ConnectionService
import kotlinx.coroutines.runBlocking
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ShellRestorationTest {
    @get:Rule
    val compose = createEmptyComposeRule()

    @Test
    fun settingsSurvivesActivityRecreation() = withPairedSession {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            compose.onNodeWithText("Settings").performClick()
            compose.onNodeWithText("Sign out").assertIsDisplayed()
            scenario.recreate()
            compose.onNodeWithText("Sign out").assertIsDisplayed()
        }
    }

    @Test
    fun deniedNotificationPermissionShowsSettingsRecovery() = withPairedSession { context ->
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val permissionWasGranted =
            context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) ==
                PackageManager.PERMISSION_GRANTED
        if (permissionWasGranted) {
            instrumentation.uiAutomation.revokeRuntimePermission(
                context.packageName,
                Manifest.permission.POST_NOTIFICATIONS
            )
        }
        try {
            ActivityScenario.launch(MainActivity::class.java).use {
                compose.onNodeWithText("Settings").performClick()
                compose.onNodeWithText("Notifications are off").assertIsDisplayed()
                compose.onNodeWithText("Open notification settings").assertIsDisplayed()
            }
        } finally {
            if (permissionWasGranted) {
                instrumentation.uiAutomation.grantRuntimePermission(
                    context.packageName,
                    Manifest.permission.POST_NOTIFICATIONS
                )
            }
        }
    }

    @Test
    fun warmNotificationIntentSelectsHomeFromSettings() = withPairedSession {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            compose.onNodeWithText("Settings").performClick()
            compose.onNodeWithText("Sign out").assertIsDisplayed()
            scenario.onActivity { activity ->
                activity.startActivity(
                    Intent(activity, MainActivity::class.java)
                        .putExtra(MainActivity.EXTRA_PUSH_ID, PUSH_ID)
                        .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
                )
            }
            compose.onNodeWithText("Nothing here yet").assertIsDisplayed()
        }
    }

    @Test
    fun coldNotificationIntentIsNotReplayedAfterRecreation() = withPairedSession { context ->
        val notificationIntent =
            Intent(context, MainActivity::class.java)
                .setData("pneumo://notification/body/$PUSH_ID".toUri())
                .putExtra(MainActivity.EXTRA_PUSH_ID, PUSH_ID)
        ActivityScenario.launch<MainActivity>(notificationIntent).use { scenario ->
            compose.onNodeWithText("Nothing here yet").assertIsDisplayed()
            compose.onNodeWithText("Settings").performClick()
            compose.onNodeWithText("Sign out").assertIsDisplayed()
            scenario.recreate()
            compose.onNodeWithText("Sign out").assertIsDisplayed()
        }
    }

    private fun withPairedSession(block: (Context) -> Unit) {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val credentials = SecureStore.create(context)
        val preferences = SessionPreferences.create(context)
        try {
            runBlocking {
                credentials.save(ByteArray(KEY_BYTES), Base64Url.encode(ByteArray(KEY_BYTES)))
                preferences.saveSession(ORIGIN, DEVICE_ID)
                preferences.completeOnboarding()
            }
            block(context)
        } finally {
            ConnectionService.stop(context)
            runBlocking {
                credentials.clear()
                preferences.clearSession()
            }
        }
    }

    private companion object {
        const val KEY_BYTES = 32
        const val ORIGIN = "https://pneumo.example.com"
        const val DEVICE_ID = "0192e7ce-7c00-7000-8000-000000000001"
        const val PUSH_ID = "0192e7ce-7c00-7000-8000-000000000002"
    }
}
