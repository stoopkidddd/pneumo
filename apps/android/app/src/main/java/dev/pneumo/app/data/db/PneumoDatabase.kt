package dev.pneumo.app.data.db

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.TypeConverters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

@Database(
    entities = [PushEntity::class, DeviceEntity::class, SyncStateEntity::class],
    version = 1,
    exportSchema = true
)
@TypeConverters(DatabaseConverters::class)
abstract class PneumoDatabase : RoomDatabase() {
    abstract fun pushes(): PushDao

    abstract fun devices(): DeviceDao

    abstract fun syncState(): SyncStateDao

    suspend fun wipe() {
        withContext(Dispatchers.IO) {
            clearAllTables()
        }
    }

    companion object {
        fun create(context: Context): PneumoDatabase = Room.databaseBuilder(
            context.applicationContext,
            PneumoDatabase::class.java,
            "pneumo.db"
        ).build()
    }
}
