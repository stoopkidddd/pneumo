package dev.pneumo.app.transfer

import android.Manifest
import android.app.Application
import android.app.NotificationManager
import android.content.Context
import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import androidx.work.Configuration
import androidx.work.Data
import androidx.work.ListenableWorker
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.WorkerFactory
import androidx.work.WorkerParameters
import androidx.work.testing.SynchronousExecutor
import androidx.work.testing.WorkManagerTestInitHelper
import dev.pneumo.app.crypto.Base64Url
import dev.pneumo.app.crypto.FileCrypto
import dev.pneumo.app.net.ApiClient
import dev.pneumo.app.protocol.Envelope
import dev.pneumo.app.protocol.FilePayload
import dev.pneumo.app.protocol.PayloadFile
import dev.pneumo.app.protocol.PushDTO
import dev.pneumo.app.protocol.PushFile
import dev.pneumo.app.sync.DecryptedPush
import java.io.ByteArrayOutputStream
import java.io.OutputStream
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class DownloadWorkerTest {
    private val context = ApplicationProvider.getApplicationContext<Application>()
    private lateinit var server: MockWebServer
    private lateinit var destinations: RecordingDestinations
    private lateinit var workManager: WorkManager
    private lateinit var api: ApiClient

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        destinations = RecordingDestinations()
        api = ApiClient(server.url("/"), TOKEN)
        shadowOf(context).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
        context.getSystemService(NotificationManager::class.java).cancelAll()
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    @Test
    fun proxyMetadataAndContentRequestsStreamDecryptExactBytes() = runTest {
        val plaintext = ByteArray(70_001) { (it * 31).toByte() }
        val ciphertext = encrypt(plaintext)
        server.enqueue(metadataResponse("/api/files/$FILE_ID/content"))
        server.enqueue(bytesResponse(ciphertext))

        initialize(push(plaintext.size.toLong(), ciphertext.size.toLong()))
        val info = runWorker()

        assertEquals(WorkInfo.State.SUCCEEDED, info.state)
        assertTrue(destinations.last.bytes.toByteArray().contentEquals(plaintext))
        assertTrue(destinations.last.completed)
        assertFalse(destinations.last.deleted)
        assertEquals("/api/files/$FILE_ID", server.takeRequest().path)
        assertEquals("/api/files/$FILE_ID/content", server.takeRequest().path)
    }

    @Test
    fun multiChunkDecryptionWritesPlaintextToDestinationInBulk() = runTest {
        val plaintext = ByteArray(196_731) { (it * 17 + 3).toByte() }
        val ciphertext = encrypt(plaintext)
        server.enqueue(metadataResponse("/api/files/$FILE_ID/content"))
        server.enqueue(bytesResponse(ciphertext))

        initialize(push(plaintext.size.toLong(), ciphertext.size.toLong()))
        val info = runWorker()

        assertEquals(WorkInfo.State.SUCCEEDED, info.state)
        assertTrue(destinations.last.bytes.toByteArray().contentEquals(plaintext))
        assertTrue(destinations.last.bulkWrites > 0)
        assertEquals(0, destinations.last.scalarWrites)
    }

    @Test
    fun directMetadataTargetStreamsDecryptExactBytesWithoutForwardingBearer() = runTest {
        val plaintext = ByteArray(1_048_576) { (it xor (it ushr 8)).toByte() }
        val ciphertext = encrypt(plaintext)
        server.enqueue(metadataResponse(server.url("/direct-download").toString()))
        server.enqueue(bytesResponse(ciphertext))

        initialize(push(plaintext.size.toLong(), ciphertext.size.toLong()))
        val info = runWorker()
        val metadataRequest = server.takeRequest()
        val directRequest = server.takeRequest()

        assertEquals(WorkInfo.State.SUCCEEDED, info.state)
        assertTrue(destinations.last.bytes.toByteArray().contentEquals(plaintext))
        assertTrue(metadataRequest.getHeader("Authorization")?.startsWith("Bearer ") == true)
        assertNull(directRequest.getHeader("Authorization"))
        assertEquals("/direct-download", directRequest.path)
        assertTerminalNotification(listOf("Open", "Share"))
    }

    @Test
    fun tamperedCiphertextFailsWithExactMessageAndDeletesPartialDestination() = runTest {
        val plaintext = ByteArray(70_001) { it.toByte() }
        val ciphertext = encrypt(plaintext).also { it[it.lastIndex] = (it.last().toInt() xor 1).toByte() }
        server.enqueue(metadataResponse("/api/files/$FILE_ID/content"))
        server.enqueue(bytesResponse(ciphertext))

        initialize(push(plaintext.size.toLong(), ciphertext.size.toLong()))
        val info = runWorker()

        assertEquals(WorkInfo.State.FAILED, info.state)
        assertEquals(DownloadWorker.CORRUPTED_FILE, info.outputData.getString(DownloadWorker.OUTPUT_ERROR))
        assertTrue(destinations.last.bytes.size() > 0)
        assertTrue(destinations.last.deleted)
        assertFalse(destinations.last.completed)
        assertTerminalNotification(listOf("Download"))
    }

    @Test
    fun interruptedContentStreamRetriesAndDeletesPartialDestination() = runTest {
        val plaintext = ByteArray(200_000) { (it * 13).toByte() }
        val ciphertext = encrypt(plaintext)
        server.enqueue(metadataResponse("/api/files/$FILE_ID/content"))
        server.enqueue(
            bytesResponse(ciphertext).setSocketPolicy(SocketPolicy.DISCONNECT_DURING_RESPONSE_BODY)
        )

        initialize(push(plaintext.size.toLong(), ciphertext.size.toLong()))
        val info = runWorker()

        assertEquals(WorkInfo.State.ENQUEUED, info.state)
        assertEquals(1, info.runAttemptCount)
        assertTrue(destinations.last.deleted)
        assertFalse(destinations.last.completed)
    }

    @Test
    fun serverFailureRetriesWithoutCreatingDestination() = runTest {
        server.enqueue(MockResponse().setResponseCode(500).setBody("unavailable"))

        initialize(push(1, FileCrypto.ciphertextSize(1)))
        val info = runWorker()

        assertEquals(WorkInfo.State.ENQUEUED, info.state)
        assertEquals(1, info.runAttemptCount)
        assertTrue(destinations.created.isEmpty())
        assertEquals("/api/files/$FILE_ID", server.takeRequest().path)
    }

    @Test
    fun nonRetryableMetadataFailurePostsTheTerminalDownloadAction() = runTest {
        server.enqueue(MockResponse().setResponseCode(403))
        initialize(push(1, FileCrypto.ciphertextSize(1)))

        val info = runWorker()

        assertEquals(WorkInfo.State.FAILED, info.state)
        assertEquals(DownloadWorker.DOWNLOAD_FAILED, info.outputData.getString(DownloadWorker.OUTPUT_ERROR))
        assertTerminalNotification(listOf("Download"))
    }

    @Test
    fun initiatingDeviceMismatchFailsBeforeMetadataOrContentRequest() = runTest {
        initialize(
            push(1, FileCrypto.ciphertextSize(1)),
            sessionDeviceId = OTHER_DEVICE_ID
        )

        val info = runWorker()

        assertEquals(WorkInfo.State.FAILED, info.state)
        assertEquals(DownloadWorker.SESSION_CHANGED, info.outputData.getString(DownloadWorker.OUTPUT_ERROR))
        assertEquals(0, server.requestCount)
        assertTrue(destinations.created.isEmpty())
    }

    private fun assertTerminalNotification(actions: List<String>) {
        val manager = context.getSystemService(NotificationManager::class.java)
        val status = manager.activeNotifications.single { it.tag == PUSH_ID }
        assertEquals(PUSH_ID.hashCode(), status.id)
        assertEquals(actions, status.notification.actions.map { it.title.toString() })
    }

    private fun initialize(stored: DecryptedPush, sessionDeviceId: String = SESSION_DEVICE_ID) {
        val dependencies = DownloadWorkerDependencies(
            openSession = {
                DownloadSession(
                    deviceId = sessionDeviceId,
                    loadPush = { id -> stored.takeIf { id == PUSH_ID } },
                    getFile = api::getFile,
                    download = api::downloadFrom,
                    finishSession = { block -> block() }
                )
            },
            destinations = destinations
        )
        val configuration = Configuration.Builder()
            .setExecutor(SynchronousExecutor())
            .setWorkerFactory(Factory(dependencies))
            .build()
        WorkManagerTestInitHelper.initializeTestWorkManager(context, configuration)
        workManager = WorkManager.getInstance(context)
    }

    private suspend fun runWorker(): WorkInfo {
        val request = OneTimeWorkRequestBuilder<DownloadWorker>()
            .setInputData(
                Data.Builder()
                    .putString(DownloadWorker.INPUT_PUSH_ID, PUSH_ID)
                    .putString(DownloadWorker.INPUT_SESSION_DEVICE_ID, SESSION_DEVICE_ID)
                    .build()
            )
            .build()
        workManager.enqueue(request).result.get(5, TimeUnit.SECONDS)
        return checkNotNull(
            workManager.getWorkInfoByIdFlow(request.id).first { info ->
                info?.isFinishedOrRetried() == true
            }
        )
    }

    private fun WorkInfo.isFinishedOrRetried(): Boolean =
        state.isFinished || (state == WorkInfo.State.ENQUEUED && runAttemptCount > 0)

    private fun push(plaintextSize: Long, ciphertextSize: Long): DecryptedPush {
        val payload = FilePayload(
            file = PayloadFile(
                name = "report.bin",
                mime = "application/octet-stream",
                size = plaintextSize,
                key = Base64Url.encode(FILE_KEY)
            )
        )
        return DecryptedPush(
            push = PushDTO(
                id = PUSH_ID,
                createdAt = TIMESTAMP,
                sourceDeviceId = SOURCE_DEVICE_ID,
                targetDeviceId = null,
                envelope = Envelope(1, Base64Url.encode(ByteArray(12)), Base64Url.encode(ByteArray(16))),
                file = PushFile(FILE_ID, ciphertextSize)
            ),
            payload = payload,
            notified = true
        )
    }

    private fun encrypt(plaintext: ByteArray): ByteArray = ByteArrayOutputStream().use { output ->
        plaintext.inputStream().use { input -> FileCrypto.encrypt(input, output, FILE_KEY, FILE_ID) }
        output.toByteArray()
    }

    private fun metadataResponse(url: String): MockResponse = MockResponse()
        .setResponseCode(200)
        .setHeader("Content-Type", "application/json")
        .setBody("""{"download":{"url":"$url","headers":{}},"expiresAt":"$TIMESTAMP"}""")

    private fun bytesResponse(bytes: ByteArray): MockResponse = MockResponse()
        .setResponseCode(200)
        .setBody(Buffer().write(bytes))

    private class Factory(private val dependencies: DownloadWorkerDependencies) : WorkerFactory() {
        override fun createWorker(
            appContext: Context,
            workerClassName: String,
            workerParameters: WorkerParameters
        ): ListenableWorker? = if (workerClassName == DownloadWorker::class.java.name) {
            DownloadWorker(appContext, workerParameters, dependencies)
        } else {
            null
        }
    }

    private class RecordingDestinations : DownloadDestinationFactory {
        val created = mutableListOf<RecordingDestination>()
        val last: RecordingDestination get() = created.last()

        override fun create(name: String, mime: String): DownloadDestination = RecordingDestination().also(created::add)
    }

    private class RecordingDestination : DownloadDestination {
        val bytes = ByteArrayOutputStream()
        var bulkWrites = 0
        var scalarWrites = 0
        var completed = false
        var deleted = false
        override val uri: Uri = Uri.parse("content://dev.pneumo.app.test/download")
        private val output = object : OutputStream() {
            override fun write(value: Int) {
                scalarWrites += 1
                bytes.write(value)
            }

            override fun write(buffer: ByteArray, offset: Int, length: Int) {
                bulkWrites += 1
                bytes.write(buffer, offset, length)
            }
        }

        override fun openOutput(): OutputStream = output

        override fun complete() {
            completed = true
        }

        override fun delete() {
            deleted = true
        }
    }

    private companion object {
        const val PUSH_ID = "018f0c6e-7a00-7000-8000-000000000002"
        const val FILE_ID = "018f0c6e-7a00-7000-8000-000000000003"
        const val SOURCE_DEVICE_ID = "018f0c6e-7a00-7000-8000-000000000004"
        const val SESSION_DEVICE_ID = "018f0c6e-7a00-7000-8000-000000000005"
        const val OTHER_DEVICE_ID = "018f0c6e-7a00-7000-8000-000000000006"
        const val TIMESTAMP = "2026-10-30T12:00:00.000Z"
        val FILE_KEY = ByteArray(32) { (it * 7).toByte() }
        val TOKEN = Base64Url.encode(ByteArray(32) { 9 })
    }
}
