package dev.pneumo.app.transfer

import android.app.Application
import android.content.Context
import android.net.Uri
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.work.Configuration
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.testing.SynchronousExecutor
import androidx.work.testing.WorkManagerTestInitHelper
import dev.pneumo.app.crypto.Base64Url
import dev.pneumo.app.crypto.FileCrypto
import dev.pneumo.app.crypto.PushCrypto
import dev.pneumo.app.data.AppSession
import dev.pneumo.app.data.KeyWrapper
import dev.pneumo.app.data.SessionCache
import dev.pneumo.app.data.db.PneumoDatabase
import dev.pneumo.app.net.ApiClient
import dev.pneumo.app.protocol.FilePayload
import dev.pneumo.app.protocol.ProtocolJson
import dev.pneumo.app.sync.PushRepository
import java.io.File
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.jsonObject
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class UploadSchedulerTest {
    @get:Rule
    val temporary = TemporaryFolder()

    private lateinit var context: Context
    private lateinit var database: PneumoDatabase
    private lateinit var workManager: WorkManager
    private lateinit var workDirectory: File
    private lateinit var store: UploadWorkStore
    private lateinit var schedulerDependencies: UploadSchedulerDependencies
    private lateinit var session: AppSession

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext<Application>()
        UploadAttachments.preparedDirectory(context).deleteRecursively()
        database = Room.inMemoryDatabaseBuilder(context, PneumoDatabase::class.java)
            .allowMainThreadQueries()
            .build()
        val configuration = Configuration.Builder()
            .setMinimumLoggingLevel(android.util.Log.ERROR)
            .setExecutor(SynchronousExecutor())
            .build()
        WorkManagerTestInitHelper.initializeTestWorkManager(context, configuration)
        workManager = WorkManager.getInstance(context)
        workDirectory = temporary.newFolder("work")
        store = UploadWorkStore(
            directory = workDirectory,
            sourceDirectory = temporary.newFolder("jobs"),
            keyWrapper = TestKeyWrapper()
        )
        schedulerDependencies = UploadSchedulerDependencies(store, workManager)
        val contentKey = SecretKeySpec(CONTENT_KEY, "AES")
        val cache = SessionCache()
        session = AppSession(
            api = ApiClient("https://example.test/".toHttpUrl(), BEARER_TOKEN),
            pushes = PushRepository(database, contentKey),
            contentKey = contentKey,
            deviceId = DEVICE_ID,
            cache = cache,
            generation = cache.generation()
        )
    }

    @After
    fun tearDown() {
        UploadAttachments.preparedDirectory(context).deleteRecursively()
        WorkManagerTestInitHelper.closeWorkDatabase()
        database.close()
    }

    @Test
    fun rejectsCiphertextOverLimitBeforeEnqueueWithExactMessage() = runTest {
        val attachment = prepareAttachment("small.bin", byteArrayOf(7))
        val preparedFile = File(checkNotNull(attachment.uri.path))
        val maxFileBytes = FileCrypto.ciphertextSize(attachment.size) - 1L
        assertTrue(attachment.size < maxFileBytes)

        val failure = runCatching {
            UploadScheduler.enqueue(
                context = context,
                session = session,
                attachments = listOf(attachment),
                options = options(maxFileBytes = maxFileBytes),
                dependencies = schedulerDependencies
            )
        }.exceptionOrNull()

        assertTrue(failure is IllegalArgumentException)
        assertEquals("This file is too large to send.", failure?.message)
        assertTrue(workManager.getWorkInfosByTag(UploadScheduler.WORK_TAG).get().isEmpty())
        assertTrue(workDirectory.listFiles().isNullOrEmpty())
        assertTrue(preparedFile.exists())
        UploadAttachments.discard(context, listOf(attachment))
    }

    @Test
    fun enqueuesOnePersistedItemPerFileWithCaptionOnlyOnFirst() = runTest {
        val attachments = listOf(
            prepareAttachment("alpha.txt", byteArrayOf(1, 2)),
            prepareAttachment("beta.bin", byteArrayOf(3, 4, 5)),
            prepareAttachment("gamma.dat", byteArrayOf(6))
        )

        UploadScheduler.enqueue(
            context = context,
            session = session,
            attachments = attachments,
            options = options(title = "Quarterly files", body = "Review these"),
            dependencies = schedulerDependencies
        )

        val work = queuedWork()
        assertEquals(attachments.size, work.items.size)
        work.items.zip(attachments).forEachIndexed { index, (item, attachment) ->
            val payload = PushCrypto.decrypt(session.contentKey, item.request.id, item.request.envelope)
                as FilePayload
            assertEquals(if (index == 0) "Quarterly files" else null, payload.title)
            assertEquals(if (index == 0) "Review these" else null, payload.body)
            assertEquals(attachment.name, payload.file.name)
            assertEquals(attachment.mime, payload.file.mime)
            assertEquals(FileCrypto.ciphertextSize(attachment.size), item.ciphertextSize)
            assertEquals(attachment.size, payload.file.size)
            assertTrue(payload.file.key == item.fileKey)
            assertEquals(TARGET_DEVICE_ID, item.request.targetDeviceId)
            assertFalse(File(checkNotNull(attachment.uri.path)).exists())
        }
    }

    @Test
    fun omitsBlankTitleAndBodyFromPersistedPayload() = runTest {
        val attachment = prepareAttachment("blank.txt", byteArrayOf(4, 2))

        UploadScheduler.enqueue(
            context = context,
            session = session,
            attachments = listOf(attachment),
            options = options(title = "   ", body = "\t"),
            dependencies = schedulerDependencies
        )

        val item = queuedWork().items.single()
        val payload = PushCrypto.decrypt(session.contentKey, item.request.id, item.request.envelope)
            as FilePayload
        val encoded = ProtocolJson.encodeToJsonElement(FilePayload.serializer(), payload).jsonObject
        assertNull(payload.title)
        assertNull(payload.body)
        assertFalse("title" in encoded)
        assertFalse("body" in encoded)
    }

    private fun queuedWork(): StoredUploadWork {
        val infos = workManager.getWorkInfosByTag(UploadScheduler.WORK_TAG).get()
        assertEquals(1, infos.size)
        assertEquals(WorkInfo.State.ENQUEUED, infos.single().state)
        val spoolFiles = workDirectory.listFiles { file -> file.extension == "work" }.orEmpty()
        assertEquals(1, spoolFiles.size)
        return store.read(spoolFiles.single().name.removeSuffix(".work"))
    }

    private suspend fun prepareAttachment(name: String, bytes: ByteArray): UploadAttachment {
        val source = temporary.newFile(name).apply { writeBytes(bytes) }
        return UploadAttachments.prepare(context, listOf(Uri.fromFile(source))).single()
    }

    private fun options(title: String? = null, body: String? = null, maxFileBytes: Long = 1_000_000L): UploadOptions =
        UploadOptions(
            targetDeviceId = TARGET_DEVICE_ID,
            title = title,
            body = body,
            maxFileBytes = maxFileBytes,
            maxEnvelopeBytes = 65_536L
        )

    private class TestKeyWrapper : KeyWrapper {
        private val key = SecretKeySpec(ByteArray(32) { (it + 17).toByte() }, "AES")
        private val random = SecureRandom()

        override fun wrap(plaintext: ByteArray): ByteArray {
            val nonce = ByteArray(12).also(random::nextBytes)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, key, GCMParameterSpec(128, nonce))
            return nonce + cipher.doFinal(plaintext)
        }

        override fun unwrap(wrapped: ByteArray): ByteArray {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, wrapped, 0, 12))
            return cipher.doFinal(wrapped, 12, wrapped.size - 12)
        }
    }

    private companion object {
        val CONTENT_KEY = ByteArray(32) { (it + 51).toByte() }
        val BEARER_TOKEN = Base64Url.encode(ByteArray(32))
        const val DEVICE_ID = "018f0c6e-7a00-7000-8000-000000000021"
        const val TARGET_DEVICE_ID = "018f0c6e-7a00-7000-8000-000000000022"
    }
}
