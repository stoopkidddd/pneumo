package dev.pneumo.app.ui.home

import android.app.Application
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import dev.pneumo.app.data.AppSession
import dev.pneumo.app.data.SessionCache
import dev.pneumo.app.data.TextPushes
import dev.pneumo.app.data.db.PneumoDatabase
import dev.pneumo.app.data.db.toEntity
import dev.pneumo.app.net.ApiClient
import dev.pneumo.app.net.FIXED_FAKE_BEARER
import dev.pneumo.app.net.PUSH_ID
import dev.pneumo.app.net.PUSH_RESPONSE
import dev.pneumo.app.protocol.NotePayload
import dev.pneumo.app.protocol.PushDTO
import dev.pneumo.app.sync.PushRepository
import dev.pneumo.app.ui.MainDispatcherRule
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import javax.crypto.SecretKey
import javax.crypto.spec.SecretKeySpec
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class RoomHomeDataSourceTest {
    private lateinit var database: PneumoDatabase
    private lateinit var server: MockWebServer

    @get:Rule
    val mainDispatcherRule = MainDispatcherRule()

    @Before
    fun setUp() {
        database = Room.inMemoryDatabaseBuilder(
            ApplicationProvider.getApplicationContext<Application>(),
            PneumoDatabase::class.java
        ).allowMainThreadQueries().build()
        server = MockWebServer()
        server.start()
    }

    @After
    fun tearDown() {
        server.shutdown()
        database.close()
    }

    @Test
    fun pendingHistoryGetFinishesBeforeDeleteSoStalePageCannotRestorePush() = runTest {
        val pageStarted = CountDownLatch(1)
        val releasePage = CountDownLatch(1)
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.method) {
                "GET" -> {
                    pageStarted.countDown()
                    check(releasePage.await(5, TimeUnit.SECONDS)) { "History response was not released" }
                    jsonResponse("""{"pushes":[$PUSH_RESPONSE],"nextBefore":"$PUSH_ID"}""")
                }

                "DELETE" -> MockResponse().setResponseCode(204)

                else -> MockResponse().setResponseCode(500)
            }
        }
        val cache = SessionCache()
        val key = SecretKeySpec(ByteArray(32), "AES")
        val session = AppSession(
            api = ApiClient(server.url("/"), FIXED_FAKE_BEARER),
            pushes = PushRepository(database, key),
            contentKey = key,
            deviceId = DEVICE_ID,
            cache = cache,
            generation = cache.generation()
        )
        val source = RoomHomeDataSource(session, database)

        val page = async(start = CoroutineStart.UNDISPATCHED) { source.loadPage(before = null) }
        assertTrue(pageStarted.await(5, TimeUnit.SECONDS))
        val delete = async(start = CoroutineStart.UNDISPATCHED) { source.deletePush(PUSH_ID) }
        releasePage.countDown()

        page.await()
        delete.await()

        assertNull(database.pushes().find(PUSH_ID))
        assertEquals("GET", server.takeRequest().method)
        assertEquals("DELETE", server.takeRequest().method)
    }

    @Test
    fun historyDecryptsAwayFromTheMainCollectorDispatcher() = runTest(mainDispatcherRule.dispatcher) {
        val mainThread = Thread.currentThread()
        val decryptingThread = AtomicReference<Thread>()
        val key = SecretKeySpec(ByteArray(32), "AES")
        val observedKey = object : SecretKey {
            override fun getAlgorithm(): String = key.algorithm
            override fun getFormat(): String = key.format
            override fun getEncoded(): ByteArray {
                decryptingThread.set(Thread.currentThread())
                return key.encoded
            }
        }
        val request = TextPushes.request(TextPushes.payload("History dispatcher regression"), null, key, 65_536L)
        val push = PushDTO(
            id = request.id,
            createdAt = "2026-10-31T12:00:00.000Z",
            sourceDeviceId = DEVICE_ID,
            targetDeviceId = null,
            envelope = request.envelope,
            file = null
        )
        database.pushes().insert(push.toEntity())
        val cache = SessionCache()
        val source = RoomHomeDataSource(
            AppSession(
                api = ApiClient(server.url("/"), FIXED_FAKE_BEARER),
                pushes = PushRepository(database, observedKey),
                contentKey = key,
                deviceId = DEVICE_ID,
                cache = cache,
                generation = cache.generation()
            ),
            database
        )

        val history = withContext(Dispatchers.Main.immediate) {
            assertEquals(mainThread, Thread.currentThread())
            source.history.first()
        }

        assertEquals("History dispatcher regression", (history.single().payload as NotePayload).body)
        assertNotSame(mainThread, requireNotNull(decryptingThread.get()))
    }

    private fun jsonResponse(body: String): MockResponse = MockResponse()
        .setResponseCode(200)
        .setHeader("Content-Type", "application/json")
        .setBody(body)

    private companion object {
        const val DEVICE_ID = "018f0c6e-7a00-7000-8000-000000000001"
    }
}
