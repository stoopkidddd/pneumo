package dev.pneumo.app.data

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.Base64
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.job
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class SecureStoreTest {
    @Test
    fun realKeystoreRoundTripAndClear() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val directory = File(context.cacheDir, "secure-store-test").apply { mkdirs() }
        val file = File(directory, "roundtrip.preferences_pb")
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        try {
            val dataStore = PreferenceDataStoreFactory.create(scope = scope, produceFile = { file })
            val key = ByteArray(KEY_BYTES) { 1 }
            val token = Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(KEY_BYTES))
            SecureStore(dataStore, KeystoreKeyWrapper()).save(key, token)
            // A new wrapper must load the persisted Keystore key, not a process-local fake.
            val reopened = SecureStore(dataStore, KeystoreKeyWrapper())
            val credentials = reopened.read()
            assertTrue("Real Keystore must recover MK", credentials?.masterKey?.contentEquals(key) == true)
            assertTrue("Real Keystore must recover token", credentials?.token == token)
            reopened.clear()
            assertNull(reopened.read())
        } finally {
            scope.coroutineContext.job.cancelAndJoin()
            directory.deleteRecursively()
        }
    }

    private companion object {
        const val KEY_BYTES = 32
    }
}
