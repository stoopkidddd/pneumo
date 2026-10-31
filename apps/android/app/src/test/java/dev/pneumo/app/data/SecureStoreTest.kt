package dev.pneumo.app.data

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import java.io.File
import java.util.Base64
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.job
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class SecureStoreTest {
    @get:Rule
    val temporaryFolder = TemporaryFolder()

    private var scope = newScope()
    private val file by lazy { File(temporaryFolder.root, "credentials.preferences_pb") }
    private val wrapper = FakeKeyWrapper()

    @After
    fun stopDataStore() = runBlocking {
        scope.coroutineContext.job.cancelAndJoin()
    }

    @Test
    fun credentialsSurviveReopeningWithoutPlaintextOnDisk() = runBlocking {
        val first = newStore()
        assertNull(first.read())
        first.save(MASTER_KEY, TOKEN)
        scope.coroutineContext.job.cancelAndJoin()
        scope = newScope()
        val reopened = newStore().read()
        assertTrue("Master key must survive reopening", reopened?.masterKey?.contentEquals(MASTER_KEY) == true)
        assertTrue("Token must survive reopening", reopened?.token == TOKEN)
        val persisted = file.readText()
        assertTrue("Token must not be persisted in plaintext", !persisted.contains(TOKEN))
        assertTrue("Master key must not be persisted in plaintext", !persisted.contains(encode(MASTER_KEY)))
    }

    @Test
    fun replacementAndClearAffectBothCredentials() = runBlocking {
        val store = newStore()
        store.save(MASTER_KEY, TOKEN)
        val nextKey = ByteArray(KEY_BYTES) { 2 }
        val nextToken = encode(ByteArray(KEY_BYTES) { 3 })
        store.save(nextKey, nextToken)
        val replaced = store.read()
        assertTrue("Replacement must replace MK", replaced?.masterKey?.contentEquals(nextKey) == true)
        assertTrue("Replacement must replace token", replaced?.token == nextToken)
        store.clear()
        assertNull(store.read())
        scope.coroutineContext.job.cancelAndJoin()
        scope = newScope()
        assertNull(newStore().read())
    }

    @Test
    fun tamperedCiphertextFailsRatherThanReturningCredentials() {
        val dataStore = PreferenceDataStoreFactory.create(scope = scope, produceFile = { file })
        val store = SecureStore(dataStore, wrapper)
        runBlocking {
            store.save(MASTER_KEY, TOKEN)
            dataStore.edit {
                val key = stringPreferencesKey("wrapped_credentials_v1")
                val bytes = Base64.getUrlDecoder().decode(it[key])
                bytes[bytes.lastIndex] = (bytes.last().toInt() xor 1).toByte()
                it[key] = encode(bytes)
            }
        }
        assertThrows(AEADBadTagException::class.java) { runBlocking { store.read() } }
    }

    @Test
    fun rejectsInvalidCredentialsWithoutReplacingSession() {
        val store = newStore()
        runBlocking { store.save(MASTER_KEY, TOKEN) }
        assertThrows(IllegalArgumentException::class.java) {
            runBlocking { store.save(ByteArray(KEY_BYTES - 1), TOKEN) }
        }
        assertThrows(IllegalArgumentException::class.java) {
            runBlocking { store.save(MASTER_KEY, "$TOKEN=") }
        }
        runBlocking {
            val credentials = store.read()
            assertTrue("Invalid save must preserve session", credentials?.token == TOKEN)
        }
    }

    private fun newStore(): SecureStore = SecureStore(
        PreferenceDataStoreFactory.create(scope = scope, produceFile = { file }),
        wrapper
    )

    private class FakeKeyWrapper : KeyWrapper {
        private val key = SecretKeySpec(ByteArray(KEY_BYTES), "AES")

        override fun wrap(plaintext: ByteArray): ByteArray {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, key)
            return cipher.iv + cipher.doFinal(plaintext)
        }

        override fun unwrap(wrapped: ByteArray): ByteArray {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_BITS, wrapped, 0, NONCE_BYTES))
            return cipher.doFinal(wrapped, NONCE_BYTES, wrapped.size - NONCE_BYTES)
        }
    }

    private companion object {
        const val KEY_BYTES = 32
        const val NONCE_BYTES = 12
        const val TAG_BITS = 128
        val MASTER_KEY = ByteArray(KEY_BYTES) { 1 }
        val TOKEN = encode(ByteArray(KEY_BYTES))

        fun newScope(): CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

        fun encode(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
    }
}
