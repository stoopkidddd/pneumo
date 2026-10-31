package dev.pneumo.app.data

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.first

private val Context.sessionDataStore by preferencesDataStore(name = "session")

data class SessionMetadata(val origin: String?, val deviceId: String?, val onboardingComplete: Boolean)

interface SessionStore {
    suspend fun read(): SessionMetadata

    suspend fun saveSession(origin: String, deviceId: String)

    suspend fun completeOnboarding()

    suspend fun clearSession()
}

class SessionPreferences(private val dataStore: DataStore<Preferences>) : SessionStore {
    override suspend fun read(): SessionMetadata {
        val values = dataStore.data.first()
        return SessionMetadata(
            origin = values[SERVER_ORIGIN],
            deviceId = values[DEVICE_ID],
            onboardingComplete = values[ONBOARDING_COMPLETE] ?: false
        )
    }

    override suspend fun saveSession(origin: String, deviceId: String) {
        dataStore.edit { values ->
            values[SERVER_ORIGIN] = origin
            values[DEVICE_ID] = deviceId
        }
    }

    override suspend fun completeOnboarding() {
        dataStore.edit { it[ONBOARDING_COMPLETE] = true }
    }

    override suspend fun clearSession() {
        dataStore.edit { values ->
            values.remove(SERVER_ORIGIN)
            values.remove(DEVICE_ID)
        }
    }

    companion object {
        private val SERVER_ORIGIN = stringPreferencesKey("server_origin")
        private val DEVICE_ID = stringPreferencesKey("own_device_id")
        private val ONBOARDING_COMPLETE = booleanPreferencesKey("onboarding_complete")

        fun create(context: Context): SessionPreferences =
            SessionPreferences(context.applicationContext.sessionDataStore)
    }
}
