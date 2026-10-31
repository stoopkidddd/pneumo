package dev.pneumo.app.ui.home

import android.app.Application
import android.content.Context
import android.net.Uri
import androidx.core.net.toUri
import androidx.lifecycle.ViewModelStore
import androidx.test.core.app.ApplicationProvider
import dev.pneumo.app.protocol.CreatePushRequest
import dev.pneumo.app.protocol.DeviceDTO
import dev.pneumo.app.protocol.ListPushesResponse
import dev.pneumo.app.protocol.Platform
import dev.pneumo.app.protocol.PushDTO
import dev.pneumo.app.sync.DecryptedPush
import dev.pneumo.app.transfer.UploadAttachment
import dev.pneumo.app.transfer.UploadAttachments
import dev.pneumo.app.transfer.UploadSourceStore
import dev.pneumo.app.ui.MainDispatcherRule
import java.io.File
import java.io.IOException
import javax.crypto.spec.SecretKeySpec
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertArrayEquals
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

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class HomeFileSendTest {
    @get:Rule
    val mainDispatcherRule = MainDispatcherRule()

    @get:Rule
    val temporary = TemporaryFolder()

    private val viewModels = ViewModelStore()
    private lateinit var source: FileHomeDataSource
    private lateinit var viewModel: HomeViewModel

    @Before
    fun setUp() {
        val context = ApplicationProvider.getApplicationContext<Application>()
        source = FileHomeDataSource(context, UploadSourceStore(temporary.newFolder("queued")))
        viewModel = HomeViewModel(source, SecretKeySpec(ByteArray(KEY_BYTES), "AES"), ENVELOPE_LIMIT)
        viewModels.put("home", viewModel)
    }

    @After
    fun tearDown() {
        viewModels.clear()
        mainDispatcherRule.dispatcher.scheduler.runCurrent()
        source.discardUploads(source.prepared)
    }

    @Test
    fun fileOnlyDraftWaitsForQueueConfirmationAndKeepsQueuedFilesAfterViewModelClear() =
        runTest(mainDispatcherRule.dispatcher) {
            val first = original("first.bin", byteArrayOf(1, 2, 3))
            val second = original("second.bin", byteArrayOf(4, 5))
            val attachments = select(first, second)
            viewModel.selectTarget(TARGET.id)
            val queue = CompletableDeferred<Unit>()
            source.enqueueGate = queue

            viewModel.send()
            runCurrent()
            assertTrue(viewModel.state.value.composer.sending)
            assertEquals("", viewModel.state.value.composer.text)
            assertTrue(attachments.all { it.snapshot().exists() })
            viewModel.attachments.remove()
            viewModel.attachments.select(listOf(Uri.fromFile(first)))
            viewModel.send()
            assertEquals(attachments, viewModel.state.value.composer.attachments)

            queue.complete(Unit)
            val sent = viewModel.state.first { !it.composer.sending && it.composer.attachments.isEmpty() }.composer
            assertEquals(TARGET.id, sent.targetDeviceId)
            assertNull(sent.error)
            val queued = source.queued.single()
            assertEquals(TARGET.id, queued.targetDeviceId)
            assertEquals("", queued.body)
            assertTrue(attachments.none { it.snapshot().exists() })
            viewModels.clear()
            runCurrent()
            assertArrayEquals(byteArrayOf(1, 2, 3), queued.files[0].readBytes())
            assertArrayEquals(byteArrayOf(4, 5), queued.files[1].readBytes())
            assertArrayEquals(byteArrayOf(1, 2, 3), first.readBytes())
            assertArrayEquals(byteArrayOf(4, 5), second.readBytes())
        }

    @Test
    fun failedFileEnqueueRetainsCaptionTargetAndSnapshotsForSuccessfulRetry() = runTest(mainDispatcherRule.dispatcher) {
        val original = original("retry.bin", byteArrayOf(7, 8, 9))
        val attachment = select(original).single()
        viewModel.updateComposerText("Keep this caption")
        viewModel.selectTarget(TARGET.id)
        source.enqueueFailure = IOException("offline")

        viewModel.send()
        val failed = viewModel.state.first { it.composer.error != null }.composer
        assertFalse(failed.sending)
        assertEquals("Keep this caption", failed.text)
        assertEquals(TARGET.id, failed.targetDeviceId)
        assertEquals(listOf(attachment), failed.attachments)
        assertArrayEquals(byteArrayOf(7, 8, 9), attachment.snapshot().readBytes())
        assertTrue(source.queued.isEmpty())

        source.enqueueFailure = null
        viewModel.send()
        val sent = viewModel.state.first { !it.composer.sending && it.composer.attachments.isEmpty() }.composer
        assertEquals("", sent.text)
        assertEquals(TARGET.id, sent.targetDeviceId)
        val queued = source.queued.single()
        assertEquals("Keep this caption", queued.body)
        assertArrayEquals(byteArrayOf(7, 8, 9), queued.files.single().readBytes())
        assertFalse(attachment.snapshot().exists())
    }

    @Test
    fun replacementAndRemovalDeleteOnlyOwnedSnapshotsAfterPreparationCompletes() =
        runTest(mainDispatcherRule.dispatcher) {
            val first = original("old.bin", byteArrayOf(1, 3, 5))
            val second = original("new.bin", byteArrayOf(2, 4, 6))
            val old = select(first).single()
            val preparation = CompletableDeferred<Unit>()
            source.prepareGate = preparation

            viewModel.attachments.select(listOf(Uri.fromFile(second)))
            runCurrent()
            assertTrue(viewModel.state.value.composer.preparingAttachments)
            assertTrue(old.snapshot().exists())
            preparation.complete(Unit)
            val replaced = viewModel.state.first {
                !it.composer.preparingAttachments && it.composer.attachments != listOf(old)
            }.composer.attachments.single()
            assertFalse(old.snapshot().exists())
            assertArrayEquals(byteArrayOf(2, 4, 6), replaced.snapshot().readBytes())

            viewModel.attachments.remove()
            assertTrue(viewModel.state.value.composer.attachments.isEmpty())
            assertFalse(replaced.snapshot().exists())
            assertArrayEquals(byteArrayOf(1, 3, 5), first.readBytes())
            assertArrayEquals(byteArrayOf(2, 4, 6), second.readBytes())
        }

    @Test
    fun preparationFailurePreservesExistingDraftSnapshot() = runTest(mainDispatcherRule.dispatcher) {
        val original = original("kept.bin", byteArrayOf(8, 6, 4))
        val attachment = select(original).single()
        source.prepareFailure = IOException("unreadable selection")

        viewModel.attachments.select(listOf(Uri.fromFile(original)))
        val failed = viewModel.state.first { it.composer.error != null }.composer

        assertFalse(failed.preparingAttachments)
        assertEquals(listOf(attachment), failed.attachments)
        assertArrayEquals(byteArrayOf(8, 6, 4), attachment.snapshot().readBytes())
    }

    @Test
    fun clearingViewModelDeletesUnqueuedSnapshotButKeepsOriginal() = runTest(mainDispatcherRule.dispatcher) {
        val original = original("unsent.bin", byteArrayOf(9, 7, 5))
        val attachment = select(original).single()

        viewModels.clear()
        runCurrent()

        assertFalse(attachment.snapshot().exists())
        assertArrayEquals(byteArrayOf(9, 7, 5), original.readBytes())
        assertTrue(source.queued.isEmpty())
    }

    private fun original(name: String, bytes: ByteArray): File = temporary.newFile(name).apply { writeBytes(bytes) }

    private suspend fun select(vararg originals: File): List<UploadAttachment> {
        viewModel.state.first { !it.loading }
        viewModel.attachments.select(originals.map(Uri::fromFile))
        return viewModel.state.first {
            !it.composer.preparingAttachments && it.composer.attachments.isNotEmpty()
        }.composer.attachments
    }

    private companion object {
        const val KEY_BYTES = 32
        const val ENVELOPE_LIMIT = 65_536L
    }
}

private val TARGET = DeviceDTO(
    id = "019a3a20-1000-7000-8000-000000000002",
    name = "Other device",
    platform = Platform.WEB,
    createdAt = "2026-10-31T09:00:00.000Z",
    lastSeenAt = "2026-10-31T09:00:00.000Z",
    online = true
)

private fun UploadAttachment.snapshot(): File = File(checkNotNull(uri.path))

private data class QueuedFiles(val files: List<File>, val targetDeviceId: String?, val body: String)

/** Real snapshot storage with a controllable queue-confirmation boundary for Home state transitions. */
private class FileHomeDataSource(private val context: Context, private val sources: UploadSourceStore) :
    HomeDataSource {
    override val history = MutableStateFlow<List<DecryptedPush>>(emptyList())
    override val devices = MutableStateFlow(listOf(TARGET))
    val prepared = mutableListOf<UploadAttachment>()
    val queued = mutableListOf<QueuedFiles>()
    var prepareGate: CompletableDeferred<Unit>? = null
    var enqueueGate: CompletableDeferred<Unit>? = null
    var prepareFailure: IOException? = null
    var enqueueFailure: IOException? = null

    override suspend fun refreshDevices() = Unit

    override suspend fun maxEnvelopeBytes(): Long = error("File sends must use the upload queue")

    override suspend fun loadPage(before: String?): ListPushesResponse = ListPushesResponse(emptyList(), null)

    override suspend fun loadPush(id: String): PushDTO = error("No remote history in file-send fixtures")

    override suspend fun createPush(request: CreatePushRequest): PushDTO = error("File sends must use the upload queue")

    override suspend fun deletePush(id: String) = error("No history deletion in file-send fixtures")

    override suspend fun prepareUploads(uris: List<Uri>): List<UploadAttachment> {
        prepareGate?.await()
        prepareFailure?.let { throw it }
        return UploadAttachments.prepare(context, uris).also(prepared::addAll)
    }

    override fun discardUploads(attachments: List<UploadAttachment>) = UploadAttachments.discard(context, attachments)

    override suspend fun enqueueFiles(attachments: List<UploadAttachment>, targetDeviceId: String?, body: String) {
        enqueueGate?.await()
        enqueueFailure?.let { throw it }
        val files = attachments.mapIndexed { index, attachment ->
            File(checkNotNull(sources.adopt(context, QUEUE_ID, index, attachment.uri).toUri().path))
        }
        queued += QueuedFiles(files, targetDeviceId, body)
    }

    private companion object {
        const val QUEUE_ID = "00000000-0000-0000-0000-000000000001"
    }
}
