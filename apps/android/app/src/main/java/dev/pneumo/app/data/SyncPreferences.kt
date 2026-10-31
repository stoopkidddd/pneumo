package dev.pneumo.app.data

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.first

private val Context.syncDataStore by preferencesDataStore(name = "sync")

interface SyncCursorStore {
    suspend fun read(): String?

    suspend fun advance(id: String)

    suspend fun clear()
}

class SyncPreferences(private val dataStore: DataStore<Preferences>) : SyncCursorStore {
    override suspend fun read(): String? = dataStore.data.first()[LAST_PUSH_ID]

    override suspend fun advance(id: String) {
        dataStore.edit { it[LAST_PUSH_ID] = id }
    }

    override suspend fun clear() {
        dataStore.edit { it.remove(LAST_PUSH_ID) }
    }

    companion object {
        private val LAST_PUSH_ID = stringPreferencesKey("last_push_id")

        fun create(context: Context): SyncPreferences = SyncPreferences(context.applicationContext.syncDataStore)
    }
}
