package dev.pneumo.app.ui.devices

import android.app.Application
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import app.cash.turbine.test
import dev.pneumo.app.data.SessionCache
import dev.pneumo.app.data.db.DeviceEntity
import dev.pneumo.app.data.db.PneumoDatabase
import dev.pneumo.app.net.DeviceApi
import dev.pneumo.app.protocol.DeviceDTO
import dev.pneumo.app.protocol.ListDevicesResponse
import dev.pneumo.app.protocol.Platform
import dev.pneumo.app.protocol.UpdateDeviceRequest
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class DeviceRepositoryTest {
    private lateinit var database: PneumoDatabase
    private lateinit var api: FakeDeviceApi
    private lateinit var cache: SessionCache
    private var generation = 0L
    private lateinit var repository: RoomDeviceRepository

    @Before
    fun createRepository() {
        database =
            Room.inMemoryDatabaseBuilder(
                ApplicationProvider.getApplicationContext<Application>(),
                PneumoDatabase::class.java
            ).allowMainThreadQueries().build()
        api = FakeDeviceApi()
        cache = SessionCache()
        generation = cache.generation()
        repository =
            RoomDeviceRepository(
                api,
                database.devices(),
                database.invalidationTracker,
                cache,
                generation
            )
    }

    @After
    fun closeDatabase() {
        database.close()
    }

    @Test
    fun roomInvalidationsUpdateObservedDevices() = runTest {
        repository.observeDevices().test {
            assertEquals(emptyList<DeviceItem>(), awaitItem())

            database.devices().upsert(staleEntity())

            assertEquals(listOf(STALE_ID), awaitItem().map { it.id })
        }
    }

    @Test
    fun refreshListsApiAndReconcilesRoomCache() = runTest {
        database.devices().upsert(staleEntity())

        repository.refresh()

        assertEquals(1, api.listCalls)
        assertNull(database.devices().find(STALE_ID))
        assertEquals(
            listOf("Firefox", "Pixel 9"),
            database.devices().list().map { it.name }
        )
    }

    @Test
    fun renameUpdatesApiThenRoom() = runTest {
        repository.refresh()

        repository.rename(OWN_ID, "Renamed phone")

        assertEquals(listOf(OWN_ID to "Renamed phone"), api.updateCalls)
        assertEquals("Renamed phone", database.devices().find(OWN_ID)?.name)
    }

    @Test
    fun removeDeletesApiThenRoom() = runTest {
        repository.refresh()

        repository.remove(OTHER_ID)

        assertEquals(listOf(OTHER_ID), api.deleteCalls)
        assertNull(database.devices().find(OTHER_ID))
    }

    @Test
    fun pendingSnapshotIsAppliedBeforeCompetingRename() = runTest {
        val snapshot = api.deferNextList()
        val refresh = async { repository.refresh() }
        runCurrent()

        val rename = async { repository.rename(OWN_ID, "Live rename") }
        runCurrent()
        assertEquals(emptyList<Pair<String, String>>(), api.updateCalls)

        snapshot.complete(staleSnapshot())
        refresh.await()
        rename.await()

        assertEquals("Live rename", database.devices().find(OWN_ID)?.name)
    }

    @Test
    fun pendingSnapshotIsAppliedBeforeCompetingRemoval() = runTest {
        val snapshot = api.deferNextList()
        val refresh = async { repository.refresh() }
        runCurrent()

        val remove = async { repository.remove(OTHER_ID) }
        runCurrent()
        assertEquals(emptyList<String>(), api.deleteCalls)

        snapshot.complete(staleSnapshot())
        refresh.await()
        remove.await()

        assertNull(database.devices().find(OTHER_ID))
    }

    @Test
    fun pendingSnapshotIsAppliedBeforeCompetingLiveMutation() = runTest {
        database.devices().upsert(ownEntity())
        val snapshot = api.deferNextList()
        val refresh = async { repository.refresh() }
        runCurrent()

        val liveMutation = async {
            cache.withDevices(generation) {
                database.devices().upsert(ownEntity(name = "Live frame rename"))
            }
        }
        runCurrent()
        assertEquals("Pixel 9", database.devices().find(OWN_ID)?.name)

        snapshot.complete(staleSnapshot())
        refresh.await()
        liveMutation.await()

        assertEquals("Live frame rename", database.devices().find(OWN_ID)?.name)
    }

    @Test
    fun resetWaitsForPendingSnapshotAndRejectsOldRepositoryMutation() = runTest {
        val snapshot = api.deferNextList()
        val refresh = async { repository.refresh() }
        runCurrent()

        val reset = async {
            cache.clear {
                database.devices().list().forEach { database.devices().delete(it.id) }
            }
        }
        runCurrent()

        snapshot.complete(staleSnapshot())
        refresh.await()
        reset.await()

        assertEquals(generation + 1, cache.generation())
        assertEquals(emptyList<DeviceEntity>(), database.devices().list())
        expectSessionChanged { repository.rename(OWN_ID, "Old session rename") }
        assertEquals(emptyList<Pair<String, String>>(), api.updateCalls)
        assertEquals(emptyList<DeviceEntity>(), database.devices().list())
    }

    private suspend fun expectSessionChanged(block: suspend () -> Unit) {
        val failure =
            try {
                block()
                null
            } catch (error: IllegalStateException) {
                error
            }
        assertEquals("The paired session has changed.", failure?.message)
    }

    private class FakeDeviceApi : DeviceApi {
        private var devices = listOf(ownDevice(), otherDevice())
        private var pendingList: CompletableDeferred<ListDevicesResponse>? = null
        var listCalls = 0
        val updateCalls = mutableListOf<Pair<String, String>>()
        val deleteCalls = mutableListOf<String>()

        fun deferNextList(): CompletableDeferred<ListDevicesResponse> {
            check(pendingList == null)
            return CompletableDeferred<ListDevicesResponse>().also { pendingList = it }
        }

        override suspend fun listDevices(): ListDevicesResponse {
            listCalls += 1
            val pending = pendingList
            pendingList = null
            return pending?.await() ?: ListDevicesResponse(devices)
        }

        override suspend fun updateDevice(id: String, request: UpdateDeviceRequest): DeviceDTO {
            updateCalls += id to request.name
            val updated = requireNotNull(devices.firstOrNull { it.id == id }).copy(name = request.name)
            devices = devices.map { if (it.id == id) updated else it }
            return updated
        }

        override suspend fun deleteDevice(id: String) {
            deleteCalls += id
            devices = devices.filterNot { it.id == id }
        }
    }

    companion object {
        private const val OWN_ID = "019a3ce4-3a80-7000-8000-000000000001"
        private const val OTHER_ID = "019a3ce4-3a80-7000-8000-000000000002"
        private const val STALE_ID = "019a3ce4-3a80-7000-8000-000000000003"
        private const val CREATED_AT = "2026-10-30T10:00:00.000Z"
        private const val LAST_SEEN_AT = "2026-10-31T11:59:00.000Z"

        private fun ownDevice() = DeviceDTO(
            name = "Pixel 9",
            platform = Platform.ANDROID,
            id = OWN_ID,
            createdAt = CREATED_AT,
            lastSeenAt = LAST_SEEN_AT,
            online = true
        )

        private fun otherDevice() = DeviceDTO(
            name = "Firefox",
            platform = Platform.WEB,
            id = OTHER_ID,
            createdAt = "2026-10-30T11:00:00.000Z",
            lastSeenAt = "2026-10-31T10:00:00.000Z",
            online = false
        )

        private fun staleSnapshot() = ListDevicesResponse(listOf(ownDevice(), otherDevice()))

        private fun ownEntity(name: String = "Pixel 9") = DeviceEntity(
            id = OWN_ID,
            name = name,
            platform = Platform.ANDROID,
            createdAt = CREATED_AT,
            lastSeenAt = LAST_SEEN_AT,
            online = true
        )

        private fun staleEntity() = DeviceEntity(
            id = STALE_ID,
            name = "Old device",
            platform = Platform.CLI,
            createdAt = CREATED_AT,
            lastSeenAt = LAST_SEEN_AT,
            online = false
        )
    }
}
