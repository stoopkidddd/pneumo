package dev.pneumo.app.data.db

import android.app.Application
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import dev.pneumo.app.protocol.Platform
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PneumoDatabaseTest {
    private lateinit var database: PneumoDatabase

    @Before
    fun createDatabase() {
        database = Room.inMemoryDatabaseBuilder(
            ApplicationProvider.getApplicationContext<Application>(),
            PneumoDatabase::class.java
        ).allowMainThreadQueries().build()
    }

    @After
    fun closeDatabase() {
        database.close()
    }

    @Test
    fun pushOrderAndNotificationClaimAreDeterministic() = runTest {
        val first = push(ID_1, CREATED_AT)
        val second = push(ID_2, CREATED_AT)
        val newest = push(ID_3, NEWER_CREATED_AT)
        database.pushes().insert(first)
        database.pushes().insert(newest)
        database.pushes().insert(second)

        assertEquals(listOf(ID_3, ID_2, ID_1), database.pushes().list().map(PushEntity::id))
        assertEquals(1, database.pushes().claimNotification(ID_2))
        assertEquals(0, database.pushes().claimNotification(ID_2))
        assertEquals(-1L, database.pushes().insert(second.copy(envelopeJson = "replacement")))
        assertTrue(requireNotNull(database.pushes().find(ID_2)).notified)
        assertEquals("{}", requireNotNull(database.pushes().find(ID_2)).envelopeJson)
    }

    @Test
    fun devicesAndSyncStateReplaceAndDelete() = runTest {
        val original = DeviceEntity(
            id = ID_1,
            name = "Phone",
            platform = Platform.ANDROID,
            createdAt = CREATED_AT,
            lastSeenAt = CREATED_AT,
            online = false
        )
        database.devices().upsert(original)
        database.devices().upsert(original.copy(name = "Pixel", online = true))
        database.syncState().put(
            SyncStateEntity(lastPushId = ID_1, lastCreatedAt = CREATED_AT)
        )

        assertEquals("Pixel", requireNotNull(database.devices().find(ID_1)).name)
        assertTrue(requireNotNull(database.devices().find(ID_1)).online)
        assertEquals(ID_1, requireNotNull(database.syncState().read()).lastPushId)
        assertEquals(1, database.devices().delete(ID_1))
        database.syncState().clear()
        assertNull(database.devices().find(ID_1))
        assertNull(database.syncState().read())
    }

    @Test
    fun wipeClearsEveryTable() = runTest {
        database.pushes().insert(push(ID_1, CREATED_AT))
        database.devices().upsert(
            DeviceEntity(ID_2, "Browser", Platform.WEB, CREATED_AT, CREATED_AT, online = true)
        )
        database.syncState().put(
            SyncStateEntity(lastPushId = ID_1, lastCreatedAt = CREATED_AT)
        )

        database.wipe()

        assertTrue(database.pushes().list().isEmpty())
        assertTrue(database.devices().list().isEmpty())
        assertNull(database.syncState().read())
        assertTrue(database.isOpen)
    }

    private fun push(id: String, createdAt: String) = PushEntity(
        id = id,
        createdAt = createdAt,
        sourceDeviceId = ID_4,
        targetDeviceId = null,
        envelopeJson = "{}",
        fileId = null,
        fileSize = null
    )

    private companion object {
        const val ID_1 = "018f0c6e-7a00-7000-8000-000000000001"
        const val ID_2 = "018f0c6e-7a00-7000-8000-000000000002"
        const val ID_3 = "018f0c6e-7a00-7000-8000-000000000003"
        const val ID_4 = "018f0c6e-7a00-7000-8000-000000000004"
        const val CREATED_AT = "2024-05-01T00:00:00.000Z"
        const val NEWER_CREATED_AT = "2024-05-02T00:00:00.000Z"
    }
}
