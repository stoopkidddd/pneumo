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
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class SyncPreferencesTest {
    @get:Rule
    val temporaryFolder = TemporaryFolder()

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val file by lazy { File(temporaryFolder.root, "sync.preferences_pb") }
    private val dataStore by lazy {
        PreferenceDataStoreFactory.create(scope = scope, produceFile = { file })
    }

    @After
    fun stopDataStore() = runBlocking {
        scope.coroutineContext.job.cancelAndJoin()
    }

    @Test
    fun cursorPersistsCallerSelectedPositionWithoutUuidOrdering() = runTest {
        val preferences = newPreferences()

        assertNull(preferences.read())
        preferences.advance(LEXICOGRAPHICALLY_HIGH_ID)
        preferences.advance(LEXICOGRAPHICALLY_LOW_ID)

        assertEquals(LEXICOGRAPHICALLY_LOW_ID, preferences.read())
        assertEquals(LEXICOGRAPHICALLY_LOW_ID, newPreferences().read())
    }

    @Test
    fun clearRemovesCursor() = runTest {
        val preferences = newPreferences()
        preferences.advance(LEXICOGRAPHICALLY_HIGH_ID)

        preferences.clear()

        assertNull(preferences.read())
    }

    private fun newPreferences(): SyncPreferences = SyncPreferences(dataStore)

    private companion object {
        const val LEXICOGRAPHICALLY_LOW_ID = "018f0c6e-7a00-7000-8000-000000000001"
        const val LEXICOGRAPHICALLY_HIGH_ID = "018f0c6e-7a00-7000-8000-000000000002"
    }
}
