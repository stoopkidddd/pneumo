package dev.pneumo.app.sync

import android.app.Application
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import dev.pneumo.app.data.SyncCursorStore
import dev.pneumo.app.data.db.PneumoDatabase
import dev.pneumo.app.data.db.SyncStateEntity
import dev.pneumo.app.data.db.toEntity
import dev.pneumo.app.net.PushApi
import dev.pneumo.app.protocol.CreatePushRequest
import dev.pneumo.app.protocol.DeviceAddedFrame
import dev.pneumo.app.protocol.DeviceDTO
import dev.pneumo.app.protocol.DeviceRemovedFrame
import dev.pneumo.app.protocol.DeviceUpdatedFrame
import dev.pneumo.app.protocol.Envelope
import dev.pneumo.app.protocol.ListPushesResponse
import dev.pneumo.app.protocol.Platform
import dev.pneumo.app.protocol.PushDTO
import dev.pneumo.app.protocol.PushDeletedFrame
import dev.pneumo.app.protocol.PushFrame
import dev.pneumo.app.protocol.ReadyFrame
import dev.pneumo.app.protocol.ReplayDoneFrame
import dev.pneumo.app.protocol.ResyncFrame
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SyncEngineTest {
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
    fun livePushesDeduplicateAndApplyEligibilityRules() = runTest {
        val cursor = FakeCursor()
        val accepted = mutableListOf<String>()
        val sink = PushSink { push: PushDTO -> accepted += push.id }
        val engine = engine(cursor = cursor, sink = sink)
        val broadcast = push(P1, source = OTHER_DEVICE)
        val fromSelf = push(P2, source = OWN_DEVICE)
        val forAnotherDevice = push(P3, source = OTHER_DEVICE, target = THIRD_DEVICE)
        val targeted = push(P4, source = OTHER_DEVICE, target = OWN_DEVICE)

        engine.apply(PushFrame("push", broadcast))
        engine.apply(PushFrame("push", broadcast))
        engine.apply(PushFrame("push", fromSelf))
        engine.apply(PushFrame("push", forAnotherDevice))
        engine.apply(PushFrame("push", targeted))
        val restartedEngine = engine(cursor = cursor, sink = sink)
        restartedEngine.apply(PushFrame("push", broadcast))

        assertEquals(listOf(P1, P4), accepted)
        assertEquals(listOf(P1, P2, P3, P4), cursor.advances)
        assertEquals(P4, cursor.value)
        assertEquals(listOf(P4, P3, P2, P1), database.pushes().list().map { it.id })
        assertTrue(requireNotNull(database.pushes().find(P1)).notified)
        assertTrue(requireNotNull(database.pushes().find(P4)).notified)
        assertFalse(requireNotNull(database.pushes().find(P2)).notified)
        assertFalse(requireNotNull(database.pushes().find(P3)).notified)
    }

    @Test
    fun deletesAndDeviceEventsUpdateRoom() = runTest {
        val engine = engine()
        val original = device(name = "Phone", online = false)
        val updated = original.copy(name = "Pixel", online = true)

        engine.apply(DeviceAddedFrame("device_added", original))
        engine.apply(DeviceUpdatedFrame("device_updated", updated))
        assertEquals("Pixel", requireNotNull(database.devices().find(OTHER_DEVICE)).name)
        assertTrue(requireNotNull(database.devices().find(OTHER_DEVICE)).online)
        engine.apply(DeviceRemovedFrame("device_removed", OTHER_DEVICE))
        assertNull(database.devices().find(OTHER_DEVICE))

        engine.apply(PushFrame("push", push(P1, source = OTHER_DEVICE)))
        engine.apply(PushDeletedFrame("push_deleted", P1))
        assertNull(database.pushes().find(P1))
    }

    @Test
    fun resyncPagesUntilRoomOverlapAndReplaysChronologically() = runTest {
        database.pushes().insert(
            push(P2, source = OTHER_DEVICE, createdAt = CREATED_AT_2).toEntity()
        )
        val api = FakePushApi(
            mapOf(
                null to ListPushesResponse(
                    pushes = listOf(
                        push(P1, createdAt = CREATED_AT_5),
                        push(P5, createdAt = CREATED_AT_4)
                    ),
                    nextBefore = P5
                ),
                P5 to ListPushesResponse(
                    pushes = listOf(
                        push(P4, createdAt = CREATED_AT_3),
                        push(P2, createdAt = CREATED_AT_2),
                        push(P3, createdAt = CREATED_AT)
                    ),
                    nextBefore = null
                )
            )
        )
        val cursor = FakeCursor(initial = P2)
        val accepted = mutableListOf<String>()
        val engine = engine(api = api, cursor = cursor, sink = PushSink { accepted += it.id })

        engine.apply(ResyncFrame("resync"))

        assertEquals(listOf(null, P5), api.befores)
        assertEquals(listOf(P4, P5, P1), accepted)
        assertEquals(listOf(P4, P5, P1), cursor.advances)
        assertEquals(P1, cursor.value)
        val position = requireNotNull(database.syncState().read())
        assertEquals(P1, position.lastPushId)
        assertEquals(CREATED_AT_5, position.lastCreatedAt)
        assertEquals(listOf(P1, P5, P4, P2), database.pushes().list().map { it.id })
        assertNull(database.pushes().find(P3))
    }

    @Test
    fun nullCursorReconnectCatchesUpFromPairingPosition() = runTest {
        database.syncState().put(SyncStateEntity(lastPushId = "", lastCreatedAt = CREATED_AT_2))
        val pages = mutableMapOf<String?, ListPushesResponse>(
            null to ListPushesResponse(listOf(push(P2, createdAt = CREATED_AT)), nextBefore = P2)
        )
        val api = FakePushApi(pages)
        val cursor = FakeCursor()
        val accepted = mutableListOf<String>()
        val sink = PushSink { accepted += it.id }
        val firstConnection = engine(api = api, cursor = cursor, sink = sink)
        firstConnection.apply(ReadyFrame("ready", OWN_DEVICE, CREATED_AT_2))
        firstConnection.apply(ReplayDoneFrame("replay_done"))
        assertNull(cursor.value)

        pages[null] = ListPushesResponse(
            listOf(
                push(P4, createdAt = CREATED_AT_3),
                push(P1, createdAt = CREATED_AT_2),
                push(P2, createdAt = CREATED_AT)
            ),
            nextBefore = P2
        )
        val reconnected = engine(api = api, cursor = cursor, sink = sink)
        reconnected.apply(ReadyFrame("ready", OWN_DEVICE, CREATED_AT_3))
        reconnected.apply(ReplayDoneFrame("replay_done"))
        reconnected.apply(PushFrame("push", push(P4, createdAt = CREATED_AT_3)))

        assertEquals(listOf(P1, P4), accepted)
        assertEquals(listOf(P1, P4), cursor.advances)
        assertEquals(P4, cursor.value)
        assertEquals(listOf(P4, P1), database.pushes().list().map { it.id })
        assertEquals(listOf(null, null), api.befores)
    }

    @Test
    fun deletedCursorResyncStopsAtStoredPositionWithEmptyRoom() = runTest {
        val api = FakePushApi(
            mapOf(
                null to ListPushesResponse(
                    listOf(
                        push(P1, createdAt = CREATED_AT_4),
                        push(P5, createdAt = CREATED_AT_3),
                        push(P2, createdAt = CREATED_AT_3)
                    ),
                    nextBefore = P2
                )
            )
        )
        val cursor = FakeCursor()
        val accepted = mutableListOf<String>()
        val engine = engine(api = api, cursor = cursor, sink = PushSink { accepted += it.id })
        engine.apply(PushFrame("push", push(P3, createdAt = CREATED_AT_3)))
        engine.apply(PushDeletedFrame("push_deleted", P3))
        assertTrue(database.pushes().list().isEmpty())
        accepted.clear()

        engine.apply(ResyncFrame("resync"))

        assertEquals(listOf(null), api.befores)
        assertEquals(listOf(P5, P1), accepted)
        assertEquals(listOf(P3, P5, P1), cursor.advances)
        assertEquals(P1, cursor.value)
        assertEquals(listOf(P1, P5), database.pushes().list().map { it.id })
        assertEquals(
            SyncStateEntity(lastPushId = P1, lastCreatedAt = CREATED_AT_4),
            database.syncState().read()
        )
    }

    @Test
    fun restartRecoversNewerDataStoreCursorWithoutRegressing() = runTest {
        val older = push(P2, createdAt = CREATED_AT_2)
        val newer = push(P5, createdAt = CREATED_AT_5)
        database.pushes().insert(older.toEntity())
        database.pushes().insert(newer.toEntity())
        database.syncState().put(
            SyncStateEntity(
                lastPushId = older.id,
                lastCreatedAt = older.createdAt
            )
        )
        val cursor = FakeCursor(initial = newer.id)
        val accepted = mutableListOf<String>()
        val engine = engine(cursor = cursor, sink = PushSink { accepted += it.id })

        engine.apply(PushFrame("push", push(P4, createdAt = CREATED_AT_4)))

        assertEquals(listOf(P4), accepted)
        assertEquals(emptyList<String>(), cursor.advances)
        assertEquals(P5, cursor.value)
        val position = requireNotNull(database.syncState().read())
        assertEquals(P5, position.lastPushId)
        assertEquals(CREATED_AT_5, position.lastCreatedAt)
    }

    @Test
    fun restartPreservesRoomPositionWhenDataStorePushWasDeleted() = runTest {
        val stored = push(P4, createdAt = CREATED_AT_4)
        database.pushes().insert(stored.toEntity())
        database.syncState().put(
            SyncStateEntity(
                lastPushId = stored.id,
                lastCreatedAt = stored.createdAt
            )
        )
        val cursor = FakeCursor(initial = P5)
        val engine = engine(cursor = cursor)

        engine.apply(PushFrame("push", push(P3, createdAt = CREATED_AT_3)))

        assertEquals(emptyList<String>(), cursor.advances)
        assertEquals(P5, cursor.value)
        val position = requireNotNull(database.syncState().read())
        assertEquals(P4, position.lastPushId)
        assertEquals(CREATED_AT_4, position.lastCreatedAt)
    }

    @Test
    fun replayFailureKeepsPerPushCursorAndDurableClaim() = runTest {
        val api = FakePushApi(
            mapOf(
                null to ListPushesResponse(
                    pushes = listOf(
                        push(P5, createdAt = CREATED_AT_5),
                        push(P4, createdAt = CREATED_AT_4),
                        push(P3, createdAt = CREATED_AT_3)
                    ),
                    nextBefore = null
                )
            )
        )
        val cursor = FakeCursor()
        val attempts = mutableListOf<String>()
        val accepted = mutableListOf<String>()
        var failOn: String? = P4
        val sink = PushSink { push ->
            attempts += push.id
            if (push.id == failOn) error("sink failed")
            accepted += push.id
        }
        val engine = engine(api = api, cursor = cursor, sink = sink)

        val failure = runCatching { engine.apply(ResyncFrame("resync")) }.exceptionOrNull()

        assertEquals("sink failed", failure?.message)
        assertEquals(listOf(P3), cursor.advances)
        assertEquals(listOf(P3, P4), attempts)
        assertEquals(listOf(P3), accepted)
        assertTrue(requireNotNull(database.pushes().find(P4)).notified)
        assertNull(database.pushes().find(P5))

        failOn = null
        engine.apply(ResyncFrame("resync"))

        assertEquals(listOf(P3, P5), accepted)
        assertEquals(listOf(P3, P4, P5), attempts)
        assertEquals(listOf(P3, P5), cursor.advances)
        assertEquals(P5, cursor.value)
        assertTrue(requireNotNull(database.pushes().find(P4)).notified)
    }

    private fun engine(
        api: PushApi = FakePushApi(emptyMap()),
        cursor: FakeCursor = FakeCursor(),
        sink: PushSink = PushSink {}
    ): SyncEngine = SyncEngine(
        database = database,
        pushApi = api,
        cursor = cursor,
        ownDeviceId = OWN_DEVICE,
        sink = sink
    )

    private fun push(
        id: String,
        source: String = OTHER_DEVICE,
        target: String? = null,
        createdAt: String = CREATED_AT
    ): PushDTO = PushDTO(
        id = id,
        createdAt = createdAt,
        sourceDeviceId = source,
        targetDeviceId = target,
        envelope = Envelope(1, "AAAAAAAAAAAAAAAA", "AAAAAAAAAAAAAAAAAAAAAA"),
        file = null
    )

    private fun device(name: String, online: Boolean): DeviceDTO = DeviceDTO(
        name = name,
        platform = Platform.ANDROID,
        id = OTHER_DEVICE,
        createdAt = CREATED_AT,
        lastSeenAt = CREATED_AT,
        online = online
    )

    private class FakeCursor(initial: String? = null) : SyncCursorStore {
        var value: String? = initial
        val advances = mutableListOf<String>()

        override suspend fun read(): String? = value

        override suspend fun advance(id: String) {
            advances += id
            value = id
        }

        override suspend fun clear() {
            value = null
        }
    }

    private class FakePushApi(private val pages: Map<String?, ListPushesResponse>) : PushApi {
        val befores = mutableListOf<String?>()

        override suspend fun listPushes(before: String?, limit: Long): ListPushesResponse {
            befores += before
            return pages.getValue(before)
        }

        override suspend fun createPush(request: CreatePushRequest): PushDTO = error("Not used")

        override suspend fun getPush(id: String): PushDTO = error("Not used")

        override suspend fun deletePush(id: String) = error("Not used")
    }

    private companion object {
        const val P1 = "018f0c6e-7a00-7000-8000-000000000001"
        const val P2 = "018f0c6e-7a00-7000-8000-000000000002"
        const val P3 = "018f0c6e-7a00-7000-8000-000000000003"
        const val P4 = "018f0c6e-7a00-7000-8000-000000000004"
        const val P5 = "018f0c6e-7a00-7000-8000-000000000005"
        const val OWN_DEVICE = "018f0c6e-7a00-7000-8000-000000000100"
        const val OTHER_DEVICE = "018f0c6e-7a00-7000-8000-000000000200"
        const val THIRD_DEVICE = "018f0c6e-7a00-7000-8000-000000000300"
        const val CREATED_AT_2 = "2024-05-01T00:00:01.000Z"
        const val CREATED_AT_3 = "2024-05-01T00:00:02.000Z"
        const val CREATED_AT_4 = "2024-05-01T00:00:03.000Z"
        const val CREATED_AT_5 = "2024-05-01T00:00:04.000Z"
        const val CREATED_AT = "2024-05-01T00:00:00.000Z"
    }
}
