package dev.pneumo.app.data

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import java.util.Base64
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withContext

private val Context.secureCredentials by preferencesDataStore(name = "secure_credentials")

/** MK and token are persisted together so clear/replacement cannot leave half a session. */
class SecureStore(private val dataStore: DataStore<Preferences>, private val keyWrapper: KeyWrapper) {
    class Credentials(val masterKey: ByteArray, val token: String)

    suspend fun save(masterKey: ByteArray, token: String): Unit = withContext(Dispatchers.IO) {
        require(masterKey.size == KEY_BYTES) { "Invalid master key length" }
        val tokenBytes = Base64.getUrlDecoder().decode(token)
        try {
            require(tokenBytes.size == KEY_BYTES && encode(tokenBytes) == token) { "Invalid device token" }
            val plaintext = ByteArray(SESSION_BYTES)
            try {
                masterKey.copyInto(plaintext)
                tokenBytes.copyInto(plaintext, KEY_BYTES)
                val ciphertext = encode(keyWrapper.wrap(plaintext))
                dataStore.edit { it[CREDENTIALS] = ciphertext }
            } finally {
                plaintext.fill(0)
            }
        } finally {
            tokenBytes.fill(0)
        }
    }

    suspend fun read(): Credentials? = withContext(Dispatchers.IO) {
        val ciphertext = dataStore.data.first()[CREDENTIALS] ?: return@withContext null
        val plaintext = keyWrapper.unwrap(Base64.getUrlDecoder().decode(ciphertext))
        try {
            require(plaintext.size == SESSION_BYTES) { "Invalid wrapped credentials" }
            val tokenBytes = plaintext.copyOfRange(KEY_BYTES, SESSION_BYTES)
            try {
                Credentials(plaintext.copyOfRange(0, KEY_BYTES), encode(tokenBytes))
            } finally {
                tokenBytes.fill(0)
            }
        } finally {
            plaintext.fill(0)
        }
    }

    suspend fun clear() {
        dataStore.edit { it.remove(CREDENTIALS) }
    }

    companion object {
        private const val KEY_BYTES = 32
        private const val SESSION_BYTES = KEY_BYTES * 2
        private val CREDENTIALS = stringPreferencesKey("wrapped_credentials_v1")

        fun create(context: Context): SecureStore = SecureStore(
            context.applicationContext.secureCredentials,
            KeystoreKeyWrapper()
        )

        private fun encode(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
    }
}
