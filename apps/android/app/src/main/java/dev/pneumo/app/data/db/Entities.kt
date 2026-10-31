package dev.pneumo.app.data.db

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey
import dev.pneumo.app.protocol.Platform

@Entity(
    tableName = "pushes",
    indices = [Index(value = ["created_at", "id"])]
)
data class PushEntity(
    @PrimaryKey val id: String,
    @ColumnInfo(name = "created_at") val createdAt: String,
    @ColumnInfo(name = "source_device_id") val sourceDeviceId: String,
    @ColumnInfo(name = "target_device_id") val targetDeviceId: String?,
    @ColumnInfo(name = "envelope_json") val envelopeJson: String,
    @ColumnInfo(name = "file_id") val fileId: String?,
    @ColumnInfo(name = "file_size") val fileSize: Long?,
    val notified: Boolean = false
) {
    init {
        require((fileId == null) == (fileSize == null)) { "File id and size must both be present or absent" }
    }
}

@Entity(tableName = "devices")
data class DeviceEntity(
    @PrimaryKey val id: String,
    val name: String,
    val platform: Platform,
    @ColumnInfo(name = "created_at") val createdAt: String,
    @ColumnInfo(name = "last_seen_at") val lastSeenAt: String,
    val online: Boolean
)

@Entity(tableName = "sync_state")
data class SyncStateEntity(
    @PrimaryKey @ColumnInfo(name = "singleton_id") val singletonId: Int = SINGLETON_ID,
    @ColumnInfo(name = "last_push_id") val lastPushId: String,
    @ColumnInfo(name = "last_created_at") val lastCreatedAt: String
) {
    init {
        require(singletonId == SINGLETON_ID) { "Only the singleton sync state row is valid" }
    }

    companion object {
        const val SINGLETON_ID = 0
    }
}
