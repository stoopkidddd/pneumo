package dev.pneumo.app.transfer

import android.app.Application
import android.os.Environment
import androidx.test.core.app.ApplicationProvider
import java.io.File
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28])
class DownloadDestinationTest {
    private val context = ApplicationProvider.getApplicationContext<Application>()

    @Test
    fun externalFileDestinationPreservesCollisionsAndUsesNextAvailableName() {
        val directory = File(
            checkNotNull(context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS)),
            "Pneumo"
        )
        assertTrue(directory.isDirectory || directory.mkdirs())
        val stem = "collision-${System.nanoTime()}"
        val original = File(directory, "$stem.ext")
        val first = File(directory, "$stem (1).ext")
        val second = File(directory, "$stem (2).ext")
        val priorBytes = "prior content".toByteArray()
        val firstBytes = ByteArray(131_173) { (it * 19).toByte() }
        val secondBytes = "second download".toByteArray()
        listOf(original, first, second).forEach { it.delete() }

        try {
            original.writeBytes(priorBytes)
            val factory = AndroidDownloadDestinationFactory(context)
            val firstDestination = factory.create(original.name, "application/octet-stream")

            assertEquals(first.name, firstDestination.uri.lastPathSegment)
            firstDestination.openOutput().use { it.write(firstBytes) }
            firstDestination.complete()
            assertArrayEquals(firstBytes, first.readBytes())
            assertArrayEquals(priorBytes, original.readBytes())

            val secondDestination = factory.create(original.name, "application/octet-stream")
            assertEquals(second.name, secondDestination.uri.lastPathSegment)
            secondDestination.openOutput().use { it.write(secondBytes) }
            secondDestination.complete()
            assertArrayEquals(secondBytes, second.readBytes())
            assertArrayEquals(firstBytes, first.readBytes())
            assertArrayEquals(priorBytes, original.readBytes())
        } finally {
            listOf(second, first, original).forEach { it.delete() }
        }
    }
}
