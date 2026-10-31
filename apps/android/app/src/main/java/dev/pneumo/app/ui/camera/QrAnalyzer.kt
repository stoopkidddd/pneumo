package dev.pneumo.app.ui.camera

import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.ReaderException
import com.google.zxing.common.HybridBinarizer

/** Reads only the luminance plane; CameraX owns and must always get its frame back. */
internal class QrAnalyzer(private val onValue: (String) -> Unit) : ImageAnalysis.Analyzer {
    private val reader = MultiFormatReader().apply {
        setHints(mapOf(DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE)))
    }
    private var luminance = ByteArray(0)

    override fun analyze(image: ImageProxy) {
        try {
            val width = image.width
            val height = image.height
            if (luminance.size != width * height) luminance = ByteArray(width * height)
            val plane = image.planes.first()
            val buffer = plane.buffer
            val offset = buffer.position()
            for (row in 0 until height) {
                for (column in 0 until width) {
                    luminance[row * width + column] =
                        buffer.get(offset + row * plane.rowStride + column * plane.pixelStride)
                }
            }
            val source = PlanarYUVLuminanceSource(luminance, width, height, 0, 0, width, height, false)
            onValue(reader.decodeWithState(BinaryBitmap(HybridBinarizer(source))).text)
        } catch (_: ReaderException) {
            // A preview frame without a readable QR code is normal.
        } finally {
            reader.reset()
            image.close()
        }
    }
}
