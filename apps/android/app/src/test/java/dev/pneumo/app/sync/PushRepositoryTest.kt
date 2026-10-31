package dev.pneumo.app.sync

import android.app.Application
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import app.cash.turbine.test
import dev.pneumo.app.crypto.PushCrypto
import dev.pneumo.app.data.db.PneumoDatabase
import dev.pneumo.app.data.db.toEntity
import dev.pneumo.app.protocol.NotePayload
import dev.pneumo.app.protocol.PushDTO
import dev.pneumo.app.protocol.PushFile
import javax.crypto.spec.SecretKeySpec
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PushRepositoryTest {
    private lateinit var database: PneumoDatabase
    private val contentKey = SecretKeySpec(ByteArray(32) { 7 }, "AES")

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
    fun decryptsOnlyWhenReadAndEmitsDatabaseChanges() = runTest {
        val repository = PushRepository(database, contentKey)
        val push = encryptedPush(BODY)

        repository.observeAll().test {
            assertEquals(emptyList<DecryptedPush>(), awaitItem())
            database.pushes().insert(push.toEntity())

            val decrypted = awaitItem().single()
            val payload = decrypted.payload as NotePayload
            assertEquals(BODY, payload.body)
            assertEquals(TITLE, payload.title)
            assertEquals(push, decrypted.push)
            assertFalse(decrypted.notified)
            cancelAndIgnoreRemainingEvents()
        }

        val stored = requireNotNull(database.pushes().find(PUSH_ID))
        assertFalse(stored.envelopeJson.contains(BODY))
        assertEquals(BODY, (requireNotNull(repository.get(PUSH_ID)).payload as NotePayload).body)
    }

    private fun encryptedPush(body: String): PushDTO {
        val payload = NotePayload(title = TITLE, body = body)
        return PushDTO(
            id = PUSH_ID,
            createdAt = CREATED_AT,
            sourceDeviceId = SOURCE_ID,
            targetDeviceId = null,
            envelope = PushCrypto.encrypt(contentKey, PUSH_ID, payload),
            file = PushFile(FILE_ID, 42)
        )
    }

    private companion object {
        const val PUSH_ID = "018f0c6e-7a00-7000-8000-000000000001"
        const val SOURCE_ID = "018f0c6e-7a00-7000-8000-000000000002"
        const val FILE_ID = "018f0c6e-7a00-7000-8000-000000000003"
        const val CREATED_AT = "2024-05-01T00:00:00.000Z"
        const val TITLE = "Private title"
        const val BODY = "Private plaintext body"
    }
}
