package dev.pneumo.app.ui.share

import android.app.Application
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import dev.pneumo.app.data.SessionCache
import dev.pneumo.app.data.TextPushes
import dev.pneumo.app.data.db.PneumoDatabase
import dev.pneumo.app.data.db.toEntity
import dev.pneumo.app.protocol.CreatePushRequest
import dev.pneumo.app.protocol.PushDTO
import javax.crypto.spec.SecretKeySpec
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ShareWorkStoreTest {
    @get:Rule
    val temporary = TemporaryFolder()

    @Test
    fun largeEncryptedEnvelopeUsesSpoolBeyondWorkManagerDataAndSurvivesRecreation() {
        val directory = temporary.newFolder("spool")
        val store = ShareWorkStore(directory)
        val body = "durable-share-body-".repeat(2_000)
        val request = request(body, title = "spool-secret-title")
        val sessionId = "019acd35-7a00-7000-8000-000000000099"

        val spoolKey = store.write(StoredShareWork(sessionId, request))
        val persisted = directory.listFiles().orEmpty().single().readBytes()

        assertTrue(persisted.size > 10_240)
        val persistedText = persisted.toString(Charsets.UTF_8)
        assertFalse(persistedText.contains("durable-share-body"))
        assertFalse(persistedText.contains("spool-secret-title"))

        val restored = ShareWorkStore(directory).read(spoolKey)
        assertEquals(sessionId, restored.sessionDeviceId)
        assertEquals(request, restored.request)
    }

    @Test
    fun differentPairingCannotReceivePersistedShare() = runTest {
        val store = newStore()
        val request = request("paired session only")
        val key = store.write(StoredShareWork(SESSION_ID, request))
        var sendCalled = false

        val completed = runStoredShareWork(key, store) {
            ShareSendSession(
                deviceId = OTHER_SESSION_ID,
                generation = 0L,
                cache = SessionCache(),
                create = {
                    sendCalled = true
                    response(request)
                },
                store = {}
            )
        }

        assertFalse(completed)
        assertFalse(sendCalled)
        assertFalse(store.exists(key))
    }

    @Test
    fun terminalSendFailureCleansSpoolWithoutRetrying() = runTest {
        val store = newStore()
        val key = store.write(StoredShareWork(SESSION_ID, request("terminal failure")))
        var attempts = 0

        val completed = runStoredShareWork(key, store) {
            ShareSendSession(
                deviceId = SESSION_ID,
                generation = 0L,
                cache = SessionCache(),
                create = {
                    attempts += 1
                    error("network failure")
                },
                store = { error("Failed pushes must not be stored") }
            )
        }

        assertFalse(completed)
        assertEquals(1, attempts)
        assertFalse(store.exists(key))
    }

    @Test
    fun terminalStorageFailureCleansSpoolWithoutRetrying() = runTest {
        val store = newStore()
        val request = request("storage failure")
        val key = store.write(StoredShareWork(SESSION_ID, request))
        var storeAttempts = 0

        val completed = runStoredShareWork(key, store) {
            ShareSendSession(
                deviceId = SESSION_ID,
                generation = 0L,
                cache = SessionCache(),
                create = { response(request) },
                store = {
                    storeAttempts += 1
                    error("database failure")
                }
            )
        }

        assertFalse(completed)
        assertEquals(1, storeAttempts)
        assertFalse(store.exists(key))
    }

    @Test
    fun cancelledWorkerKeepsSpoolForWorkManagerReschedule() = runTest {
        val store = newStore()
        val key = store.write(StoredShareWork(SESSION_ID, request("cancelled worker")))

        try {
            runStoredShareWork(key, store) {
                ShareSendSession(
                    deviceId = SESSION_ID,
                    generation = 0L,
                    cache = SessionCache(),
                    create = { throw CancellationException("stopped") },
                    store = { error("Cancelled pushes must not be stored") }
                )
            }
        } catch (_: CancellationException) {
            // WorkManager owns cancellation and may run the same request again.
        }

        assertTrue(store.exists(key))
    }

    @Test
    fun lateResponseAfterSessionClearCannotRestoreOldCiphertext() = runTest {
        val database = Room.inMemoryDatabaseBuilder(
            ApplicationProvider.getApplicationContext<Application>(),
            PneumoDatabase::class.java
        ).allowMainThreadQueries().build()
        try {
            val store = newStore()
            val oldRequest = request("old session ciphertext")
            val key = store.write(StoredShareWork(SESSION_ID, oldRequest))
            val cache = SessionCache()
            val oldGeneration = cache.generation()
            val createStarted = CompletableDeferred<Unit>()
            val createResponse = CompletableDeferred<PushDTO>()

            val oldWriter = async {
                runStoredShareWork(key, store) {
                    ShareSendSession(
                        deviceId = SESSION_ID,
                        generation = oldGeneration,
                        cache = cache,
                        create = {
                            createStarted.complete(Unit)
                            createResponse.await()
                        },
                        store = { created -> database.pushes().insert(created.toEntity()) }
                    )
                }
            }
            createStarted.await()

            cache.clear { database.wipe() }
            val newRequest = request("new session ciphertext")
            val newPush = response(newRequest).copy(sourceDeviceId = OTHER_SESSION_ID)
            cache.withPushes(cache.generation()) {
                database.pushes().insert(newPush.toEntity())
            }
            createResponse.complete(response(oldRequest))

            assertFalse(oldWriter.await())
            assertFalse(store.exists(key))
            val persisted = database.pushes().list()
            assertEquals(listOf(newRequest.id), persisted.map { push -> push.id })
            assertEquals(newPush.toEntity().envelopeJson, persisted.single().envelopeJson)
        } finally {
            database.close()
        }
    }

    private fun newStore(): ShareWorkStore = ShareWorkStore(temporary.newFolder())

    private fun request(body: String, title: String? = null): CreatePushRequest = TextPushes.request(
        payload = TextPushes.payload(body, title),
        targetDeviceId = TARGET_ID,
        contentKey = SecretKeySpec(ByteArray(32) { 7 }, "AES"),
        maxEnvelopeBytes = 65_536
    )

    private fun response(request: CreatePushRequest): PushDTO = PushDTO(
        id = request.id,
        createdAt = "2026-10-31T12:00:00.000Z",
        sourceDeviceId = SESSION_ID,
        targetDeviceId = request.targetDeviceId,
        envelope = request.envelope,
        file = null
    )

    private companion object {
        const val SESSION_ID = "019acd35-7a00-7000-8000-000000000001"
        const val OTHER_SESSION_ID = "019acd35-7a00-7000-8000-000000000002"
        const val TARGET_ID = "019acd35-7a00-7000-8000-000000000003"
    }
}
