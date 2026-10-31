package dev.pneumo.app.ui

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import androidx.core.net.toUri
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import dev.pneumo.app.ui.camera.PairCamera
import dev.pneumo.app.ui.screens.PairActions
import dev.pneumo.app.ui.screens.PairScreen
import dev.pneumo.app.ui.screens.PairUiState

@Composable
internal fun PairEntry(error: String?, onOpenLink: (String) -> Unit, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    var granted by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
        )
    }
    var denied by rememberSaveable { mutableStateOf(false) }
    var pasteMode by rememberSaveable { mutableStateOf(false) }
    // The URI includes MK: never use rememberSaveable or a navigation argument here.
    var link by remember { mutableStateOf("") }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        granted = it
        denied = !it
    }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) {
        granted =
            ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
    }
    PairScreen(
        state = PairUiState(granted, denied, pasteMode, link, error),
        actions = PairActions(
            onLinkChange = { link = it },
            onPasteMode = {
                pasteMode = it
                link = ""
            },
            onOpenLink = {
                onOpenLink(link)
                link = ""
            },
            onRequestCamera = {
                if (denied) {
                    val settings = Intent(
                        Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        "package:${context.packageName}".toUri()
                    )
                    context.startActivity(settings)
                } else {
                    permission.launch(Manifest.permission.CAMERA)
                }
            }
        ),
        modifier = modifier,
        cameraPreview = {
            PairCamera(onValue = onOpenLink, modifier = Modifier.fillMaxSize())
        }
    )
}
