package dev.pneumo.app.data

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.job
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class SessionPreferencesTest {
    @get:Rule
    val temporaryFolder = TemporaryFolder()

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val file by lazy { File(temporaryFolder.root, "session.preferences_pb") }

    @After
    fun stopDataStore() = runBlocking {
        scope.coroutineContext.job.cancelAndJoin()
    }

    @Test
    fun persistsSessionAndOnboardingState() = runTest {
        val preferences = newPreferences()

        assertEquals(SessionMetadata(null, null, false), preferences.read())
        preferences.saveSession(ORIGIN, DEVICE_ID)
        assertEquals(SessionMetadata(ORIGIN, DEVICE_ID, false), preferences.read())
        preferences.completeOnboarding()
        assertEquals(SessionMetadata(ORIGIN, DEVICE_ID, true), preferences.read())
    }

    @Test
    fun clearingSessionKeepsOneTimeOnboardingChoice() = runTest {
        val preferences = newPreferences()
        preferences.saveSession(ORIGIN, DEVICE_ID)
        preferences.completeOnboarding()

        preferences.clearSession()

        val restored = preferences.read()
        assertNull(restored.origin)
        assertNull(restored.deviceId)
        assertTrue(restored.onboardingComplete)
    }

    private fun newPreferences(): SessionPreferences = SessionPreferences(
        PreferenceDataStoreFactory.create(scope = scope, produceFile = { file })
    )

    private companion object {
        const val ORIGIN = "https://pneumo.example.com"
        const val DEVICE_ID = "018f0c6e-7a00-7000-8000-000000000001"
    }
}
