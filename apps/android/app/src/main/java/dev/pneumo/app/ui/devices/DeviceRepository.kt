package dev.pneumo.app.ui.devices

import androidx.room.InvalidationTracker
import dev.pneumo.app.data.SessionCache
import dev.pneumo.app.data.db.DeviceDao
import dev.pneumo.app.data.db.DeviceEntity
import dev.pneumo.app.data.db.toEntity
import dev.pneumo.app.net.DeviceApi
import dev.pneumo.app.protocol.Platform
import dev.pneumo.app.protocol.UpdateDeviceRequest
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

internal data class DeviceItem(
    val id: String,
    val name: String,
    val platform: Platform,
    val createdAt: String,
    val lastSeenAt: String,
    val online: Boolean
)

internal interface DeviceRepository {
    fun observeDevices(): Flow<List<DeviceItem>>

    suspend fun refresh()

    suspend fun rename(id: String, name: String)

    suspend fun remove(id: String)
}

internal class RoomDeviceRepository(
    private val api: DeviceApi,
    private val dao: DeviceDao,
    invalidationTracker: InvalidationTracker,
    private val cache: SessionCache,
    private val generation: Long
) : DeviceRepository {
    private val invalidations = invalidationTracker.createFlow(DEVICES_TABLE, emitInitialState = true)

    override fun observeDevices(): Flow<List<DeviceItem>> = invalidations.map {
        dao.list().map(DeviceEntity::toItem)
    }

    override suspend fun refresh() = cache.withDevices(generation) {
        val remote = api.listDevices().devices
        val remoteIds = remote.mapTo(mutableSetOf()) { it.id }
        dao.list().forEach { cached ->
            if (cached.id !in remoteIds) dao.delete(cached.id)
        }
        remote.forEach { dao.upsert(it.toEntity()) }
    }

    override suspend fun rename(id: String, name: String) = cache.withDevices(generation) {
        dao.upsert(api.updateDevice(id, UpdateDeviceRequest(name)).toEntity())
    }

    override suspend fun remove(id: String) {
        cache.withDevices(generation) {
            api.deleteDevice(id)
            dao.delete(id)
        }
    }

    private companion object {
        const val DEVICES_TABLE = "devices"
    }
}

private fun DeviceEntity.toItem(): DeviceItem = DeviceItem(
    id = id,
    name = name,
    platform = platform,
    createdAt = createdAt,
    lastSeenAt = lastSeenAt,
    online = online
)
