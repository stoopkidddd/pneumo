package dev.pneumo.app.data.db

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import kotlinx.coroutines.flow.Flow

@Dao
interface PushDao {
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insert(push: PushEntity): Long

    @Query("SELECT * FROM pushes WHERE id = :id")
    suspend fun find(id: String): PushEntity?

    @Query("SELECT * FROM pushes ORDER BY created_at DESC, id DESC")
    suspend fun list(): List<PushEntity>

    @Query("SELECT * FROM pushes ORDER BY created_at DESC, id DESC")
    fun observeAll(): Flow<List<PushEntity>>

    @Query("SELECT id FROM pushes WHERE id IN (:ids)")
    suspend fun existingIds(ids: List<String>): List<String>

    @Query("UPDATE pushes SET notified = 1 WHERE id = :id AND notified = 0")
    suspend fun claimNotification(id: String): Int

    @Query("DELETE FROM pushes WHERE id = :id")
    suspend fun delete(id: String): Int
}

@Dao
interface DeviceDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(device: DeviceEntity)

    @Query("SELECT * FROM devices ORDER BY name COLLATE NOCASE, id")
    suspend fun list(): List<DeviceEntity>

    @Query("SELECT * FROM devices WHERE id = :id")
    suspend fun find(id: String): DeviceEntity?

    @Query("DELETE FROM devices WHERE id = :id")
    suspend fun delete(id: String): Int
}

@Dao
interface SyncStateDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun put(state: SyncStateEntity)

    @Query("SELECT * FROM sync_state WHERE singleton_id = 0")
    suspend fun read(): SyncStateEntity?

    @Query("DELETE FROM sync_state")
    suspend fun clear()
}
