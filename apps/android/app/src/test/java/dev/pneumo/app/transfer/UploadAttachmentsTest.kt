package dev.pneumo.app.transfer

import android.app.Application
import android.content.Context
import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import dev.pneumo.app.data.KeyWrapper
import java.io.File
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
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
class UploadAttachmentsTest {
    @get:Rule
    val temporary = TemporaryFolder()

    private lateinit var context: Context

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext<Application>()
        UploadAttachments.preparedDirectory(context).deleteRecursively()
    }

    @Test
    fun wildcardFallbackUsesExtensionAndSnapshotsImmutableBytes() = runTest {
        val source = temporary.newFile("picture.png").apply { writeBytes(byteArrayOf(1, 3, 5, 7)) }

        val attachment = UploadAttachments.prepare(context, listOf(Uri.fromFile(source)), "image/*").single()

        assertEquals("picture.png", attachment.name)
        assertEquals("image/png", attachment.mime)
        assertEquals(4L, attachment.size)
        assertNotEquals(source.canonicalPath, File(checkNotNull(attachment.uri.path)).canonicalPath)
        assertTrue(File(checkNotNull(attachment.uri.path)).readBytes().contentEquals(source.readBytes()))

        source.writeBytes(byteArrayOf(9, 9, 9, 9))
        assertTrue(File(checkNotNull(attachment.uri.path)).readBytes().contentEquals(byteArrayOf(1, 3, 5, 7)))
        UploadAttachments.discard(context, listOf(attachment))
        assertFalse(File(checkNotNull(attachment.uri.path)).exists())
    }

    @Test
    fun wildcardFallbackWithoutKnownExtensionUsesOctetStream() = runTest {
        val source = temporary.newFile("opaque.unknownextension").apply { writeText("bytes") }

        val attachment = UploadAttachments.prepare(context, listOf(Uri.fromFile(source)), "*/*").single()

        assertEquals("application/octet-stream", attachment.mime)
        UploadAttachments.discard(context, listOf(attachment))
    }

    @Test
    fun concreteFallbackIsRetainedWhenProviderHasNoType() = runTest {
        val source = temporary.newFile("opaque").apply { writeText("bytes") }

        val attachment = UploadAttachments.prepare(context, listOf(Uri.fromFile(source)), "application/pdf").single()

        assertEquals("application/pdf", attachment.mime)
        UploadAttachments.discard(context, listOf(attachment))
    }

    @Test
    fun adoptedSnapshotCanBeRestoredWhenEnqueueFails() = runTest {
        val source = temporary.newFile("retry.bin").apply { writeBytes(byteArrayOf(2, 4, 8)) }
        val attachment = UploadAttachments.prepare(context, listOf(Uri.fromFile(source))).single()
        val prepared = File(checkNotNull(attachment.uri.path))
        val store = UploadWorkStore(
            directory = temporary.newFolder("work"),
            sourceDirectory = temporary.newFolder("jobs"),
            keyWrapper = IdentityKeyWrapper
        )
        val key = store.newKey()

        store.sources.adopt(context, key, 0, attachment.uri)
        assertFalse(prepared.exists())
        store.sources.restore(context, key, listOf(attachment))

        assertTrue(prepared.exists())
        assertTrue(prepared.readBytes().contentEquals(byteArrayOf(2, 4, 8)))
        UploadAttachments.discard(context, listOf(attachment))
    }

    @Test
    fun failureDiscardsFilesPreparedEarlierInTheBatch() = runTest {
        val valid = temporary.newFile("valid.bin").apply { writeText("valid") }
        val missing = temporary.root.resolve("missing.bin")

        runCatching {
            UploadAttachments.prepare(context, listOf(Uri.fromFile(valid), Uri.fromFile(missing)))
        }.onSuccess { throw AssertionError("Expected the missing source to fail") }

        assertTrue(UploadAttachments.preparedDirectory(context).listFiles().isNullOrEmpty())
    }

    private object IdentityKeyWrapper : KeyWrapper {
        override fun wrap(plaintext: ByteArray): ByteArray = plaintext.copyOf()

        override fun unwrap(wrapped: ByteArray): ByteArray = wrapped.copyOf()
    }
}
