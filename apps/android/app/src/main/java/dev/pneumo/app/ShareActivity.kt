package dev.pneumo.app

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.lifecycle.lifecycleScope
import dev.pneumo.app.data.AppSession
import dev.pneumo.app.data.TextPushes
import dev.pneumo.app.data.db.toEntity
import dev.pneumo.app.protocol.LinkPayload
import dev.pneumo.app.transfer.UploadAttachments
import dev.pneumo.app.transfer.UploadOptions
import dev.pneumo.app.transfer.UploadScheduler
import dev.pneumo.app.ui.share.ParsedShare
import dev.pneumo.app.ui.share.ShareActions
import dev.pneumo.app.ui.share.ShareDevice
import dev.pneumo.app.ui.share.ShareIntentParser
import dev.pneumo.app.ui.share.ShareMode
import dev.pneumo.app.ui.share.ShareSheet
import dev.pneumo.app.ui.share.ShareUiState
import dev.pneumo.app.ui.share.ShareWorkScheduler
import dev.pneumo.app.ui.share.SharedText
import dev.pneumo.app.ui.theme.PneumoTheme
import java.util.Locale
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.supervisorScope
import kotlinx.coroutines.withContext

class ShareActivity : ComponentActivity() {
    private var session: AppSession? = null
    private var state by mutableStateOf(ShareUiState())
    private var maxEnvelopeBytes = 0L
    private var maxFileBytes = DEFAULT_MAX_FILE_BYTES
    private var fileShare: ParsedShare.Files? = null
    private var queued = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val parsed = ShareIntentParser.parse(intent)
        fileShare = parsed as? ParsedShare.Files
        state = when (parsed) {
            is ParsedShare.Valid -> {
                val payload = TextPushes.payload(parsed.text.body, parsed.text.title)
                ShareUiState(sharedText = parsed.text, isLink = payload is LinkPayload)
            }

            is ParsedShare.Files -> ShareUiState(sharedText = parsed.text)

            ParsedShare.Invalid -> ShareUiState(mode = ShareMode.Invalid)
        }
        setContent {
            PneumoTheme {
                Box(
                    modifier = Modifier.fillMaxSize(),
                    contentAlignment = Alignment.BottomCenter
                ) {
                    ShareSheet(
                        state = state,
                        actions = ShareActions(
                            onTargetSelect = { target ->
                                state = state.copy(selectedTargetId = target)
                            },
                            onMessageChange = { message -> state = state.copy(message = message) },
                            onSend = ::enqueueShare,
                            onPair = ::openPairing,
                            onRetry = ::loadSession,
                            onDismiss = ::finish
                        )
                    )
                }
            }
        }
        if (parsed !is ParsedShare.Invalid) loadSession()
    }

    private fun loadSession() {
        session = null
        state = state.copy(mode = ShareMode.Loading, error = null)
        lifecycleScope.launch {
            loadSession((application as PneumoApp).container)
        }
    }

    private suspend fun loadSession(container: AppContainer) {
        try {
            val opened = container.openSession()
            if (opened == null) {
                state = state.copy(mode = ShareMode.NotPaired)
            } else {
                prepareSession(container, opened)
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            state = state.copy(mode = ShareMode.LoadError, error = null)
        }
    }

    private suspend fun prepareSession(container: AppContainer, opened: AppSession) {
        session = opened
        maxEnvelopeBytes = opened.maxEnvelopeBytes
        fileShare?.let { files ->
            if (state.files.isEmpty()) {
                val attachments = UploadAttachments.prepare(this, files.uris, files.mime)
                state = state.copy(files = attachments)
            }
        }
        val cached = withContext(Dispatchers.IO) {
            container.database.devices().list().map { device ->
                ShareDevice(device.id, device.name, device.online)
            }.sortedTargets()
        }
        state = state.copy(mode = ShareMode.Ready, devices = cached)
        refreshSession(container, opened)
    }

    private suspend fun refreshSession(container: AppContainer, opened: AppSession) = supervisorScope {
        val devices = async(Dispatchers.IO) {
            opened.cache.withDevices(opened.generation) {
                val response = opened.api.listDevices()
                val refreshedIds = response.devices.mapTo(mutableSetOf()) { device -> device.id }
                container.database.devices().list()
                    .filterNot { device -> device.id in refreshedIds }
                    .forEach { device -> container.database.devices().delete(device.id) }
                response.devices.forEach { device ->
                    container.database.devices().upsert(device.toEntity())
                }
                response.devices.map { device ->
                    ShareDevice(device.id, device.name, device.online)
                }.sortedTargets()
            }
        }
        val limit = async(Dispatchers.IO) {
            opened.api.me().limits
        }
        try {
            val refreshed = devices.await()
            state = state.copy(
                devices = refreshed,
                selectedTargetId = state.selectedTargetId?.takeIf { selected ->
                    refreshed.any { device -> device.id == selected }
                },
                error = null
            )
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            state = state.copy(error = getString(R.string.share_devices_refresh_error))
        }
        try {
            val limits = limit.await()
            maxEnvelopeBytes = limits.maxEnvelopeBytes
            maxFileBytes = limits.maxFileBytes
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            // The session fallback remains valid while the server is unavailable.
        }
    }

    private fun enqueueShare() {
        if (state.sending) return
        val activeSession = session
        val sharedText = state.sharedText
        when {
            activeSession == null -> state = state.copy(mode = ShareMode.NotPaired)
            sharedText == null -> state = state.copy(mode = ShareMode.Invalid)
            else -> queueShare(activeSession, sharedText)
        }
    }

    private fun queueShare(activeSession: AppSession, sharedText: SharedText) {
        val message = state.message
        val targetDeviceId = state.selectedTargetId
        val envelopeLimit = maxEnvelopeBytes
        state = state.copy(sending = true, error = null)
        lifecycleScope.launch {
            try {
                if (state.files.isNotEmpty()) {
                    UploadScheduler.enqueue(
                        context = this@ShareActivity,
                        session = activeSession,
                        attachments = state.files,
                        options = UploadOptions(
                            targetDeviceId = targetDeviceId,
                            title = sharedText.title,
                            body = listOf(sharedText.body, message).filter(String::isNotBlank).joinToString("\n"),
                            maxFileBytes = maxFileBytes,
                            maxEnvelopeBytes = envelopeLimit
                        )
                    )
                } else {
                    val payload = TextPushes.payload(sharedText.body, sharedText.title, message)
                    val request = TextPushes.request(
                        payload = payload,
                        targetDeviceId = targetDeviceId,
                        contentKey = activeSession.contentKey,
                        maxEnvelopeBytes = envelopeLimit
                    )
                    withContext(Dispatchers.IO) {
                        ShareWorkScheduler.enqueue(this@ShareActivity, activeSession.deviceId, request)
                    }
                }
                queued = true
                finish()
            } catch (error: IllegalArgumentException) {
                state = state.copy(
                    sending = false,
                    error = error.message ?: getString(R.string.share_enqueue_error)
                )
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                state = state.copy(sending = false, error = getString(R.string.share_enqueue_error))
            }
        }
    }

    private fun List<ShareDevice>.sortedTargets(): List<ShareDevice> =
        sortedWith(compareBy<ShareDevice> { it.name.lowercase(Locale.ROOT) }.thenBy { it.id })

    private fun openPairing() {
        startActivity(
            Intent(this, MainActivity::class.java).addFlags(
                Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            )
        )
        finish()
    }

    override fun onDestroy() {
        if (!queued) UploadAttachments.discard(this, state.files)
        super.onDestroy()
    }

    private companion object {
        const val DEFAULT_MAX_FILE_BYTES = 524_288_000L
    }
}
