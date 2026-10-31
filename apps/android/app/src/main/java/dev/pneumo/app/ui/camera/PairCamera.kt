package dev.pneumo.app.ui.camera

import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import dev.pneumo.app.R
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

@Composable
internal fun PairCamera(onValue: (String) -> Unit, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current
    val previewView = remember(context) { PreviewView(context) }
    val currentOnValue by rememberUpdatedState(onValue)
    var unavailable by remember { mutableStateOf(false) }
    Box(modifier = modifier) {
        if (unavailable) {
            Text(stringResource(R.string.runtime_camera_unavailable))
        } else {
            AndroidView(factory = { previewView }, modifier = Modifier.fillMaxSize())
        }
    }
    DisposableEffect(lifecycle, previewView) {
        val executor = Executors.newSingleThreadExecutor()
        val mainExecutor = ContextCompat.getMainExecutor(context)
        val providerFuture = ProcessCameraProvider.getInstance(context)
        val active = AtomicBoolean(true)
        val pending = AtomicBoolean(false)
        val preview = Preview.Builder().build().apply { surfaceProvider = previewView.surfaceProvider }
        val analysis = ImageAnalysis.Builder()
            .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
            .build()
        analysis.setAnalyzer(
            executor,
            QrAnalyzer { value ->
                if (active.get() && pending.compareAndSet(false, true)) {
                    mainExecutor.execute {
                        if (active.get()) currentOnValue(value)
                        pending.set(false)
                    }
                }
            }
        )
        var provider: ProcessCameraProvider? = null
        providerFuture.addListener({
            if (active.get()) {
                try {
                    provider = providerFuture.get().also {
                        it.bindToLifecycle(lifecycle, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
                    }
                } catch (_: java.util.concurrent.ExecutionException) {
                    unavailable = true
                } catch (_: IllegalArgumentException) {
                    unavailable = true
                } catch (_: IllegalStateException) {
                    unavailable = true
                }
            }
        }, mainExecutor)
        onDispose {
            active.set(false)
            analysis.clearAnalyzer()
            provider?.unbind(preview, analysis)
            executor.shutdown()
        }
    }
}
