package dev.pneumo.app.transfer

import android.app.Application
import android.content.Context
import android.net.Uri
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.work.Configuration
import androidx.work.Constraints
import androidx.work.ListenableWorker
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.WorkerFactory
import androidx.work.WorkerParameters
import androidx.work.testing.SynchronousExecutor
import androidx.work.testing.WorkManagerTestInitHelper
import androidx.work.workDataOf
import dev.pneumo.app.crypto.Base64Url
import dev.pneumo.app.crypto.FileCrypto
import dev.pneumo.app.crypto.PushCrypto
import dev.pneumo.app.crypto.Uuidv7
import dev.pneumo.app.data.AppSession
import dev.pneumo.app.data.KeyWrapper
import dev.pneumo.app.data.SessionCache
import dev.pneumo.app.data.db.PneumoDatabase
import dev.pneumo.app.net.ApiClient
import dev.pneumo.app.protocol.CreatePushRequest
import dev.pneumo.app.protocol.FilePayload
import dev.pneumo.app.protocol.PayloadFile
import dev.pneumo.app.protocol.PushDTO
import dev.pneumo.app.sync.PushRepository
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.security.SecureRandom
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class UploadWorkerTest {
    private lateinit var context: Context
    private lateinit var database: PneumoDatabase
    private lateinit var server: MockWebServer
    private lateinit var store: UploadWorkStore
    private lateinit var dispatcher: UploadDispatcher
    private lateinit var dependencies: UploadWorkerDependencies
    private lateinit var workManager: WorkManager
    private val storedPushes = CopyOnWriteArrayList<PushDTO>()

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext<Application>()
        database = Room.inMemoryDatabaseBuilder(context, PneumoDatabase::class.java)
            .allowMainThreadQueries()
            .build()
        server = MockWebServer()
        dispatcher = UploadDispatcher(server)
        server.dispatcher = dispatcher
        server.start()
        store = UploadWorkStore(
            directory = context.noBackupFilesDir.resolve("upload-test-${Uuidv7.generate()}"),
            sourceDirectory = context.cacheDir.resolve("upload-test-sources-${Uuidv7.generate()}"),
            keyWrapper = TestKeyWrapper()
        )
        dependencies = dependencies(ApiClient(server.url("/"), BEARER_TOKEN))
        val configuration = Configuration.Builder()
            .setMinimumLoggingLevel(android.util.Log.ERROR)
            .setExecutor(SynchronousExecutor())
            .setWorkerFactory(UploadTestWorkerFactory { dependencies })
            .build()
        WorkManagerTestInitHelper.initializeTestWorkManager(context, configuration)
        workManager = WorkManager.getInstance(context)
    }

    @After
    fun tearDown() {
        server.shutdown()
        database.close()
    }

    @Test
    fun workerStreamsBoundaryPlaintextsForDirectAndProxyUploads() {
        val sizes = listOf(0, 1, 65_536, 1_048_576)
        sizes.forEachIndexed { index, size ->
            dispatcher.direct = index % 2 == 0
            val plaintext = ByteArray(size) { byteIndex -> (byteIndex * 31).toByte() }
            val job = writeJob(plaintext)

            val info = runWork(job.key)

            assertEquals(WorkInfo.State.SUCCEEDED, info.state)
            val upload = dispatcher.uploads.removeAt(0)
            assertEquals(FileCrypto.ciphertextSize(size.toLong()), upload.contentLength)
            assertEquals(if (dispatcher.direct) null else "Bearer $BEARER_TOKEN", upload.authorization)
            val decrypted = ByteArrayOutputStream()
            FileCrypto.decrypt(
                ByteArrayInputStream(upload.bytes),
                decrypted,
                job.fileKey,
                FILE_ID
            )
            assertArrayEquals(plaintext, decrypted.toByteArray())
            val stored = storedPushes.last()
            val payload = PushCrypto.decrypt(SecretKeySpec(CONTENT_KEY, "AES"), stored.id, stored.envelope)
                as FilePayload
            assertEquals(Base64Url.encode(job.fileKey), payload.file.key)
            assertEquals(size.toLong(), payload.file.size)
            assertFalse(store.exists(job.key))
            assertFalse(job.source.exists())
        }
        assertEquals(sizes.size, storedPushes.size)
    }

    @Test
    fun networkIOExceptionRetriesAndPreservesEncryptedSpoolAndSource() {
        dependencies = dependencies(
            ApiClient(
                server.url("/"),
                BEARER_TOKEN,
                OkHttpClient.Builder()
                    .addInterceptor(Interceptor { throw IOException("offline") })
                    .build()
            )
        )
        val job = writeJob(byteArrayOf(1, 2, 3))

        val info = runWork(job.key, retryExpected = true)

        assertEquals(WorkInfo.State.ENQUEUED, info.state)
        assertTrue(info.runAttemptCount > 0)
        assertTrue(store.exists(job.key))
        assertTrue(job.source.exists())
        assertTrue(storedPushes.isEmpty())
    }

    @Test
    fun serverFailureRetriesAndPreservesEncryptedSpoolAndSource() {
        dispatcher.reserveStatus = 503
        val job = writeJob(byteArrayOf(2, 4, 6))

        val info = runWork(job.key, retryExpected = true)

        assertEquals(WorkInfo.State.ENQUEUED, info.state)
        assertTrue(store.exists(job.key))
        assertTrue(job.source.exists())
        assertTrue(storedPushes.isEmpty())
    }

    @Test
    fun lostPushResponseRetriesTheIdenticalRequestWithoutUploadingAgain() = runBlocking {
        val failFirstPushResponse = AtomicBoolean(true)
        dependencies = dependencies(
            ApiClient(
                server.url("/"),
                BEARER_TOKEN,
                OkHttpClient.Builder()
                    .addInterceptor { chain ->
                        val response = chain.proceed(chain.request())
                        if (chain.request().url.encodedPath == "/api/pushes" &&
                            failFirstPushResponse.getAndSet(false)
                        ) {
                            response.close()
                            throw IOException("response lost")
                        }
                        response
                    }
                    .build()
            )
        )
        val job = writeJob(byteArrayOf(3, 1, 4))

        val first = runStoredUploadWork(context, job.key, dependencies)
        val persisted = store.read(job.key)
        val second = runStoredUploadWork(context, job.key, dependencies)

        assertEquals(ListenableWorker.Result.retry(), first)
        assertEquals(FILE_ID, persisted.items.single().request.file?.id)
        assertEquals(
            ListenableWorker.Result.success(workDataOf(UploadScheduler.PROGRESS_PERCENT to 100)),
            second
        )
        assertEquals(1, dispatcher.reserveCount)
        assertEquals(1, dispatcher.uploadCount)
        assertEquals(2, dispatcher.pushBodies.size)
        assertEquals(dispatcher.pushBodies[0], dispatcher.pushBodies[1])
        assertFalse(store.exists(job.key))
        assertFalse(job.source.exists())
    }

    @Test
    fun terminalClientErrorDeletesSpoolAndSource() {
        dispatcher.reserveStatus = 400
        val job = writeJob(byteArrayOf(4, 5, 6))

        val info = runWork(job.key)

        assertEquals(WorkInfo.State.FAILED, info.state)
        assertEquals("The server rejected the upload.", info.outputData.getString(UploadScheduler.ERROR_MESSAGE))
        assertFalse(store.exists(job.key))
        assertFalse(job.source.exists())
    }

    @Test
    fun currentServerLimitIsRecheckedBeforeReservation() {
        dispatcher.maxFileBytes = FileCrypto.ciphertextSize(3) - 1
        val job = writeJob(byteArrayOf(1, 2, 3))

        val info = runWork(job.key)

        assertEquals(WorkInfo.State.FAILED, info.state)
        assertEquals("This file is too large to send.", info.outputData.getString(UploadScheduler.ERROR_MESSAGE))
        assertEquals(1, server.requestCount)
        assertTrue(dispatcher.uploads.isEmpty())
        assertFalse(store.exists(job.key))
        assertFalse(job.source.exists())
    }

    @Test
    fun sessionMismatchDoesNotContactServerAndDeletesWork() {
        val job = writeJob(byteArrayOf(7, 8), sessionDeviceId = OTHER_DEVICE_ID)

        val info = runWork(job.key)

        assertEquals(WorkInfo.State.FAILED, info.state)
        assertEquals(0, server.requestCount)
        assertFalse(store.exists(job.key))
        assertFalse(job.source.exists())
    }

    @Test
    fun durableSpoolDoesNotContainMetadataOrKeys() {
        val secretName = "private-file-name.txt"
        val secretMime = "application/private-type"
        val job = writeJob(byteArrayOf(9), name = secretName, mime = secretMime)
        val spool = context.noBackupFilesDir
            .walkTopDown()
            .first { it.isFile && it.name == "${job.key}.work" }
            .readBytes()
            .toString(Charsets.UTF_8)

        assertFalse(spool.contains(secretName))
        assertFalse(spool.contains(secretMime))
        assertFalse(spool.contains(Base64Url.encode(job.fileKey)))
        store.delete(job.key)
    }

    private fun dependencies(api: ApiClient): UploadWorkerDependencies {
        val key = SecretKeySpec(CONTENT_KEY, "AES")
        val cache = SessionCache()
        val session = AppSession(
            api = api,
            pushes = PushRepository(database, key),
            contentKey = key,
            deviceId = DEVICE_ID,
            cache = cache,
            generation = cache.generation()
        )
        return UploadWorkerDependencies(
            store = store,
            openSession = { session },
            storePush = { storedPushes += it }
        )
    }

    private fun writeJob(
        plaintext: ByteArray,
        sessionDeviceId: String = DEVICE_ID,
        name: String = "boundary.bin",
        mime: String = "application/octet-stream"
    ): JobFixture {
        val key = store.newKey()
        val sourceDirectory = store.sources.directory(key)
        assertTrue(sourceDirectory.mkdirs())
        val source = sourceDirectory.resolve("0.source")
        source.writeBytes(plaintext)
        val fileKey = ByteArray(32) { (it + 1).toByte() }
        val pushId = Uuidv7.generate()
        val payload = FilePayload(
            file = PayloadFile(name, mime, plaintext.size.toLong(), Base64Url.encode(fileKey))
        )
        val item = StoredUploadItem(
            sourceUri = Uri.fromFile(source).toString(),
            plaintextSize = plaintext.size.toLong(),
            ciphertextSize = FileCrypto.ciphertextSize(plaintext.size.toLong()),
            fileKey = Base64Url.encode(fileKey),
            request = CreatePushRequest(
                id = pushId,
                targetDeviceId = null,
                envelope = PushCrypto.encrypt(SecretKeySpec(CONTENT_KEY, "AES"), pushId, payload),
                file = null
            )
        )
        store.write(key, StoredUploadWork(sessionDeviceId, listOf(item)))
        return JobFixture(key, source, fileKey)
    }

    private fun request(key: String) = OneTimeWorkRequestBuilder<UploadWorker>()
        .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
        .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
        .setInputData(workDataOf(UploadWorker.INPUT_SPOOL_KEY to key))
        .addTag(UploadScheduler.WORK_TAG)
        .build()

    private fun runWork(key: String, retryExpected: Boolean = false): WorkInfo {
        val request = request(key)
        workManager.enqueue(request).result.get()
        checkNotNull(WorkManagerTestInitHelper.getTestDriver(context)).setAllConstraintsMet(request.id)
        return runBlocking {
            checkNotNull(
                workManager.getWorkInfoByIdFlow(request.id).first { info ->
                    info != null && if (retryExpected) {
                        info.state == WorkInfo.State.ENQUEUED && info.runAttemptCount > 0
                    } else {
                        info.state.isFinished
                    }
                }
            )
        }
    }

    private data class JobFixture(val key: String, val source: java.io.File, val fileKey: ByteArray)

    private class UploadTestWorkerFactory(private val dependencies: () -> UploadWorkerDependencies) : WorkerFactory() {
        override fun createWorker(
            appContext: Context,
            workerClassName: String,
            workerParameters: WorkerParameters
        ): ListenableWorker? = if (workerClassName == UploadWorker::class.java.name) {
            UploadWorker(appContext, workerParameters, dependencies())
        } else {
            null
        }
    }

    private class UploadDispatcher(private val server: MockWebServer) : Dispatcher() {
        @Volatile var direct = false

        @Volatile var reserveStatus = 201

        @Volatile var maxFileBytes = 524_288_000L

        @Volatile var reserveCount = 0

        @Volatile var uploadCount = 0
        val pushBodies = CopyOnWriteArrayList<String>()
        val uploads = CopyOnWriteArrayList<CapturedUpload>()

        override fun dispatch(request: RecordedRequest): MockResponse = when {
            request.method == "GET" && request.path == "/api/me" -> me()
            request.method == "POST" && request.path == "/api/files" -> reserve()
            request.method == "PUT" -> upload(request)
            request.method == "POST" && request.path == "/api/pushes" -> push(request)
            else -> MockResponse().setResponseCode(404)
        }

        private fun me(): MockResponse = jsonResponse(
            """
            {
              "device": {
                "name": "Phone",
                "platform": "android",
                "id": "$DEVICE_ID",
                "createdAt": "$TIMESTAMP",
                "lastSeenAt": "$TIMESTAMP",
                "online": true
              },
              "keyCheck": "$BEARER_TOKEN",
              "limits": {"maxFileBytes": $maxFileBytes, "maxEnvelopeBytes": 65536},
              "vapidPublicKey": "${"A".repeat(87)}",
              "uploadMode": "auto"
            }
            """.trimIndent(),
            200
        )

        private fun reserve(): MockResponse {
            reserveCount += 1
            if (reserveStatus != 201) {
                return jsonResponse(
                    """{"error":{"code":"rejected","message":"No"}}""",
                    reserveStatus
                )
            }
            val uploadUrl = if (direct) {
                server.url("/direct/$FILE_ID").toString()
            } else {
                "/api/files/$FILE_ID/content"
            }
            return jsonResponse(
                """
                {
                  "fileId": "$FILE_ID",
                  "upload": {"method": "PUT", "url": "$uploadUrl", "headers": {}},
                  "expiresAt": "$TIMESTAMP"
                }
                """.trimIndent(),
                201
            )
        }

        private fun upload(request: RecordedRequest): MockResponse {
            uploadCount += 1
            uploads += CapturedUpload(
                bytes = request.body.readByteArray(),
                contentLength = checkNotNull(request.getHeader("Content-Length")).toLong(),
                authorization = request.getHeader("Authorization")
            )
            return MockResponse().setResponseCode(204)
        }

        private fun push(request: RecordedRequest): MockResponse {
            val body = request.body.readUtf8()
            pushBodies += body
            val submitted = kotlinx.serialization.json.Json.parseToJsonElement(body).jsonObject
            val response = buildJsonObject {
                put("id", checkNotNull(submitted["id"]))
                put("createdAt", JsonPrimitive(TIMESTAMP))
                put("sourceDeviceId", JsonPrimitive(DEVICE_ID))
                put("targetDeviceId", submitted["targetDeviceId"] ?: JsonNull)
                put("envelope", checkNotNull(submitted["envelope"]))
                put(
                    "file",
                    buildJsonObject {
                        put("id", JsonPrimitive(FILE_ID))
                        put("size", JsonPrimitive(checkNotNull(uploads.lastOrNull()).contentLength))
                    }
                )
            }
            return jsonResponse(response.toString(), 201)
        }

        private fun jsonResponse(body: String, status: Int): MockResponse = MockResponse()
            .setResponseCode(status)
            .setHeader("Content-Type", "application/json")
            .setBody(body)
    }

    private data class CapturedUpload(val bytes: ByteArray, val contentLength: Long, val authorization: String?)

    private class TestKeyWrapper : KeyWrapper {
        private val key = SecretKeySpec(ByteArray(32) { (it + 11).toByte() }, "AES")
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
        val CONTENT_KEY = ByteArray(32) { (it + 41).toByte() }
        const val BEARER_TOKEN = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        const val DEVICE_ID = "018f0c6e-7a00-7000-8000-000000000001"
        const val OTHER_DEVICE_ID = "018f0c6e-7a00-7000-8000-000000000099"
        const val FILE_ID = "018f0c6e-7a00-7000-8000-000000000003"
        const val TIMESTAMP = "2026-10-30T12:00:00.000Z"
    }
}
