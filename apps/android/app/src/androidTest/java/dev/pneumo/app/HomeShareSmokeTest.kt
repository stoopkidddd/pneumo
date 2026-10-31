package dev.pneumo.app

import android.content.Intent
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.pneumo.app.crypto.Base64Url
import dev.pneumo.app.data.SecureStore
import dev.pneumo.app.data.SessionPreferences
import dev.pneumo.app.protocol.NotePayload
import dev.pneumo.app.service.ConnectionService
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class HomeShareSmokeTest {
    @get:Rule
    val compose = createEmptyComposeRule()

    @Test
    fun destinationsAndShareSurviveActivityFinishing() = verifyShare(failFirstPush = false)

    @Test
    fun transientFailureRetriesAfterShareActivityFinishes() = verifyShare(failFirstPush = true)

    private fun verifyShare(failFirstPush: Boolean) {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val container = (context.applicationContext as PneumoApp).container
        val credentials = SecureStore.create(context)
        val preferences = SessionPreferences.create(context)
        AndroidSmokeApi(failFirstPush).use { api ->
            try {
                runBlocking {
                    container.database.wipe()
                    credentials.save(ByteArray(KEY_BYTES), Base64Url.encode(ByteArray(KEY_BYTES)))
                    preferences.saveSession(api.origin, AndroidSmokeApi.DEVICE_ID)
                    preferences.completeOnboarding()
                }
                ActivityScenario.launch(MainActivity::class.java).use {
                    compose.onNodeWithText("Devices").performClick()
                    compose.waitUntil(TIMEOUT_MS) {
                        compose.onAllNodesWithText("Smoke phone").fetchSemanticsNodes().isNotEmpty()
                    }
                    compose.onNodeWithText("Smoke phone").assertIsDisplayed()
                    compose.onNodeWithText("Settings").performClick()
                    compose.onNodeWithText("Sign out").performScrollTo().assertIsDisplayed()
                    compose.onNodeWithText("Home").performClick()
                    compose.onNodeWithText("Nothing here yet").assertIsDisplayed()
                }
                val share = Intent(context, ShareActivity::class.java)
                    .setAction(Intent.ACTION_SEND)
                    .setType("text/plain")
                    .putExtra(Intent.EXTRA_TEXT, SHARED_TEXT)
                ActivityScenario.launch<ShareActivity>(share).use { scenario ->
                    compose.waitUntil(TIMEOUT_MS) {
                        compose.onAllNodesWithText("All devices").fetchSemanticsNodes().isNotEmpty()
                    }
                    compose.onNodeWithText("Send").performClick()
                    compose.waitUntil(TIMEOUT_MS) { scenario.state == androidx.lifecycle.Lifecycle.State.DESTROYED }
                }
                ActivityScenario.launch(MainActivity::class.java).use {
                    compose.waitUntil(if (failFirstPush) RETRY_TIMEOUT_MS else TIMEOUT_MS) {
                        compose.onAllNodesWithText(SHARED_TEXT).fetchSemanticsNodes().isNotEmpty()
                    }
                    compose.onNodeWithText(SHARED_TEXT).assertIsDisplayed()
                    runBlocking { verifyStoredPush(container, api, failFirstPush) }
                }
            } finally {
                ConnectionService.stop(context)
                runBlocking {
                    clearSmokeSession(container, credentials, preferences)
                }
            }
        }
    }

    private suspend fun verifyStoredPush(container: AppContainer, api: AndroidSmokeApi, retried: Boolean) {
        val session = requireNotNull(container.openSession())
        val push = session.pushes.list().single()
        val payload = push.payload
        assertTrue(payload is NotePayload && payload.body == SHARED_TEXT)
        val requests = api.receivedPushes()
        assertEquals(if (retried) 2 else 1, requests.size)
        assertEquals(push.push.id, requests.first().id)
        if (retried) assertEquals(requests.first(), requests.last())
    }

    private suspend fun clearSmokeSession(
        container: AppContainer,
        credentials: SecureStore,
        preferences: SessionPreferences
    ) {
        val session = container.openSession()
        credentials.clear()
        preferences.clearSession()
        if (session != null) {
            session.cache.clear { container.database.wipe() }
        } else {
            container.database.wipe()
        }
    }

    private companion object {
        const val KEY_BYTES = 32
        const val TIMEOUT_MS = 15_000L
        const val RETRY_TIMEOUT_MS = 60_000L
        const val SHARED_TEXT = "Managed share reached Home"
    }
}
