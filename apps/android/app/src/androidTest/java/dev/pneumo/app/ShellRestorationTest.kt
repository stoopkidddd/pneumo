package dev.pneumo.app

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.pneumo.app.crypto.Base64Url
import dev.pneumo.app.data.SecureStore
import dev.pneumo.app.data.SessionPreferences
import kotlinx.coroutines.runBlocking
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ShellRestorationTest {
    @get:Rule
    val compose = createEmptyComposeRule()

    @Test
    fun settingsSurvivesActivityRecreation() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val credentials = SecureStore.create(context)
        val preferences = SessionPreferences.create(context)
        try {
            runBlocking {
                credentials.save(ByteArray(KEY_BYTES), Base64Url.encode(ByteArray(KEY_BYTES)))
                preferences.saveSession("https://pneumo.example.com", "0192e7ce-7c00-7000-8000-000000000001")
                preferences.completeOnboarding()
            }
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                compose.onNodeWithText("Settings").performClick()
                compose.onNodeWithText("Sign out").assertIsDisplayed()
                scenario.recreate()
                compose.onNodeWithText("Sign out").assertIsDisplayed()
            }
        } finally {
            runBlocking {
                credentials.clear()
                preferences.clearSession()
            }
        }
    }

    private companion object {
        const val KEY_BYTES = 32
    }
}
