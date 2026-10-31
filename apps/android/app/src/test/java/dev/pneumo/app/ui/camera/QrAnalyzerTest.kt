package dev.pneumo.app.ui.camera

import androidx.camera.core.ImageProxy
import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter
import java.lang.reflect.Proxy
import java.nio.ByteBuffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class QrAnalyzerTest {
    @Test
    fun paddedLuminanceFrameDecodesAndIsReturned() {
        val matrix = QRCodeWriter().encode("Camera frame smoke", BarcodeFormat.QR_CODE, SIZE, SIZE)
        val stride = SIZE * PIXEL_STRIDE + PADDING
        val bytes = ByteArray(stride * SIZE) { 0xff.toByte() }
        for (row in 0 until SIZE) {
            for (column in 0 until SIZE) {
                bytes[row * stride + column * PIXEL_STRIDE] = if (matrix[column, row]) 0 else 0xff.toByte()
            }
        }
        var decoded: String? = null
        var closed = false
        QrAnalyzer { decoded = it }.analyze(frame(bytes, stride) { closed = true })
        assertEquals("Camera frame smoke", decoded)
        assertTrue(closed)
    }

    @Test
    fun unreadableFrameIsReturnedWithoutReportingAValue() {
        var decoded: String? = null
        var closed = false
        QrAnalyzer { decoded = it }.analyze(
            frame(ByteArray(SIZE * SIZE * PIXEL_STRIDE), SIZE * PIXEL_STRIDE) {
                closed =
                    true
            }
        )
        assertEquals(null, decoded)
        assertTrue(closed)
    }

    private fun frame(bytes: ByteArray, rowStride: Int, onClose: () -> Unit): ImageProxy {
        val plane = Proxy.newProxyInstance(
            ImageProxy.PlaneProxy::class.java.classLoader,
            arrayOf(ImageProxy.PlaneProxy::class.java)
        ) { _, method, _ ->
            when (method.name) {
                "getBuffer" -> ByteBuffer.wrap(bytes)
                "getRowStride" -> rowStride
                "getPixelStride" -> PIXEL_STRIDE
                else -> error("Unexpected plane operation")
            }
        } as ImageProxy.PlaneProxy
        return Proxy.newProxyInstance(
            ImageProxy::class.java.classLoader,
            arrayOf(ImageProxy::class.java)
        ) { _, method, _ ->
            when (method.name) {
                "getWidth", "getHeight" -> SIZE
                "getPlanes" -> arrayOf(plane)
                "close" -> onClose()
                else -> error("Unexpected frame operation")
            }
        } as ImageProxy
    }

    companion object {
        private const val SIZE = 160
        private const val PIXEL_STRIDE = 2
        private const val PADDING = 8
    }
}
