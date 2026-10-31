package dev.pneumo.app.ui.home

import android.content.res.Configuration
import androidx.compose.runtime.Composable
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.tooling.preview.PreviewParameter
import androidx.compose.ui.tooling.preview.PreviewParameterProvider
import dev.pneumo.app.net.ws.ConnectionState
import dev.pneumo.app.protocol.DeviceDTO
import dev.pneumo.app.protocol.Envelope
import dev.pneumo.app.protocol.FilePayload
import dev.pneumo.app.protocol.LinkPayload
import dev.pneumo.app.protocol.NotePayload
import dev.pneumo.app.protocol.PayloadFile
import dev.pneumo.app.protocol.Platform
import dev.pneumo.app.protocol.PushDTO
import dev.pneumo.app.protocol.PushFile
import dev.pneumo.app.sync.DecryptedPush
import dev.pneumo.app.ui.theme.PneumoTheme

enum class HomePreviewCase(val fileName: String) {
    Empty("home-empty"),
    Loading("home-loading"),
    ListAllTypes("home-list-all-types"),
    ListNote("home-list-note"),
    ListLink("home-list-link"),
    ListFile("home-list-file"),
    Offline("home-offline"),
    HistoryError("home-error"),
    DeleteUndo("home-delete-undo"),
    ComposerIdle("home-composer-idle"),
    ComposerSending("home-composer-sending"),
    ComposerError("home-composer-error")
}

class HomePreviewProvider : PreviewParameterProvider<HomePreviewCase> {
    override val values: Sequence<HomePreviewCase> = HomePreviewCase.entries.asSequence()
}

@Preview(name = "Light", widthDp = 360, heightDp = 800)
@Preview(name = "Dark", widthDp = 360, heightDp = 800, uiMode = Configuration.UI_MODE_NIGHT_YES)
@Composable
internal fun HomePreview(@PreviewParameter(HomePreviewProvider::class) fixture: HomePreviewCase) {
    PneumoTheme { HomePreviewContent(fixture) }
}

@Composable
fun HomePreviewContent(fixture: HomePreviewCase) {
    val devices = previewDevices()
    val pushes = previewHistory(fixture)
    val composer = when (fixture) {
        HomePreviewCase.ComposerIdle -> HomeComposerState(text = "A note for my other devices")

        HomePreviewCase.ComposerSending -> HomeComposerState(
            text = "https://pneumo.example.com/dispatch",
            targetDeviceId = DEVICE_ANDROID,
            sending = true
        )

        HomePreviewCase.ComposerError -> HomeComposerState(
            text = "Keep this draft after a failed send",
            targetDeviceId = DEVICE_WEB,
            error = "Could not send. Check your connection and try again."
        )

        else -> HomeComposerState()
    }
    HomeScreen(
        state = HomeUiState(
            pushes = pushes,
            devices = devices,
            loading = fixture == HomePreviewCase.Loading,
            nextBefore = null,
            error = if (fixture == HomePreviewCase.HistoryError) {
                "Could not load your history or devices. Check your connection and try again."
            } else {
                null
            },
            highlightedPushId = if (fixture == HomePreviewCase.ListLink) PUSH_LINK else null,
            hiddenPushIds = if (fixture == HomePreviewCase.DeleteUndo) setOf(PUSH_NOTE) else emptySet(),
            undoPushId = if (fixture == HomePreviewCase.DeleteUndo) PUSH_NOTE else null,
            composer = composer
        ),
        connection = if (fixture == HomePreviewCase.Offline) {
            ConnectionState.Offline
        } else {
            ConnectionState.Connected
        },
        actions = HomeActions({}, {}, {}, {}, {}, {}, {})
    )
}

private fun previewHistory(fixture: HomePreviewCase): List<DecryptedPush> {
    val allPushes = previewPushes()
    val pushes = when (fixture) {
        HomePreviewCase.Empty, HomePreviewCase.Loading, HomePreviewCase.HistoryError,
        HomePreviewCase.ComposerIdle, HomePreviewCase.ComposerSending,
        HomePreviewCase.ComposerError -> emptyList()

        HomePreviewCase.ListAllTypes, HomePreviewCase.Offline,
        HomePreviewCase.DeleteUndo -> allPushes

        HomePreviewCase.ListNote -> allPushes.filter { it.push.id == PUSH_NOTE }

        HomePreviewCase.ListLink -> allPushes.filter { it.push.id == PUSH_LINK }

        HomePreviewCase.ListFile -> allPushes.filter { it.push.id == PUSH_FILE }
    }
    return pushes
}

private fun previewDevices(): List<DeviceDTO> = listOf(
    DeviceDTO(
        id = DEVICE_ANDROID,
        name = "Pixel 9",
        platform = Platform.ANDROID,
        createdAt = "2026-10-29T08:00:00.000Z",
        lastSeenAt = "2026-10-31T09:42:00.000Z",
        online = true
    ),
    DeviceDTO(
        id = DEVICE_WEB,
        name = "Firefox on Linux",
        platform = Platform.WEB,
        createdAt = "2026-10-28T08:00:00.000Z",
        lastSeenAt = "2026-10-30T21:15:00.000Z",
        online = false
    )
)

private fun previewPushes(): List<DecryptedPush> = listOf(
    decrypted(
        id = PUSH_NOTE,
        source = DEVICE_ANDROID,
        createdAt = "2026-10-31T09:42:00.000Z",
        payload = NotePayload(body = "Meet beside the north entrance at 18:30.")
    ),
    decrypted(
        id = PUSH_LINK,
        source = DEVICE_WEB,
        createdAt = "2026-10-31T08:18:00.000Z",
        payload = LinkPayload(url = "https://pneumo.example.com")
    ),
    DecryptedPush(
        push = PushDTO(
            id = PUSH_FILE,
            createdAt = "2026-10-30T19:05:00.000Z",
            sourceDeviceId = DEVICE_WEB,
            targetDeviceId = DEVICE_ANDROID,
            envelope = PREVIEW_ENVELOPE,
            file = PushFile(id = FILE_ID, size = 248_928L)
        ),
        payload = FilePayload(
            file = PayloadFile(
                name = "switchboard-plan.pdf",
                mime = "application/pdf",
                size = 248_832L,
                key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
            )
        ),
        notified = true
    )
)

private fun decrypted(
    id: String,
    source: String,
    createdAt: String,
    payload: dev.pneumo.app.protocol.PushPayload
): DecryptedPush = DecryptedPush(
    push = PushDTO(
        id = id,
        createdAt = createdAt,
        sourceDeviceId = source,
        targetDeviceId = null,
        envelope = PREVIEW_ENVELOPE,
        file = null
    ),
    payload = payload,
    notified = true
)

private val PREVIEW_ENVELOPE = Envelope(
    v = 1,
    n = "AAAAAAAAAAAAAAAA",
    c = "AAAAAAAAAAAAAAAAAAAAAA"
)
private const val DEVICE_ANDROID = "019a3a20-1000-7000-8000-000000000001"
private const val DEVICE_WEB = "019a3a20-1000-7000-8000-000000000002"
private const val PUSH_NOTE = "019a3a20-2000-7000-8000-000000000001"
private const val PUSH_LINK = "019a3a20-2000-7000-8000-000000000002"
private const val PUSH_FILE = "019a3a20-2000-7000-8000-000000000003"
private const val FILE_ID = "019a3a20-3000-7000-8000-000000000001"
