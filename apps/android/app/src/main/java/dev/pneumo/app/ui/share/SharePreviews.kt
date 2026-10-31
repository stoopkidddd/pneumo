package dev.pneumo.app.ui.share

import android.content.res.Configuration
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.tooling.preview.PreviewParameter
import androidx.compose.ui.tooling.preview.PreviewParameterProvider
import dev.pneumo.app.transfer.UploadAttachment
import dev.pneumo.app.ui.theme.PneumoTheme

enum class SharePreviewCase(val fileName: String) {
    Paired("share-paired"),
    Loading("share-loading"),
    NotPaired("share-not-paired"),
    Invalid("share-invalid"),
    LoadError("share-load-error"),
    Sending("share-sending"),
    Error("share-error"),
    Files("share-files")
}

internal class SharePreviewProvider : PreviewParameterProvider<SharePreviewCase> {
    override val values: Sequence<SharePreviewCase> = SharePreviewCase.entries.asSequence()
}

@Preview(name = "Light", widthDp = 360, heightDp = 800)
@Preview(name = "Dark", widthDp = 360, heightDp = 800, uiMode = Configuration.UI_MODE_NIGHT_YES)
@Composable
internal fun ShareScreenPreview(@PreviewParameter(SharePreviewProvider::class) fixture: SharePreviewCase) {
    PneumoTheme { SharePreviewContent(fixture) }
}

@Composable
internal fun SharePreviewContent(fixture: SharePreviewCase) {
    val state = when (fixture) {
        SharePreviewCase.Loading -> ShareUiState(mode = ShareMode.Loading)

        SharePreviewCase.NotPaired -> ShareUiState(mode = ShareMode.NotPaired)

        SharePreviewCase.Invalid -> ShareUiState(mode = ShareMode.Invalid)

        SharePreviewCase.LoadError -> ShareUiState(mode = ShareMode.LoadError)

        SharePreviewCase.Sending -> pairedState().copy(sending = true)

        SharePreviewCase.Error -> pairedState().copy(error = "Couldn’t queue this share. Try again.")

        SharePreviewCase.Paired -> pairedState()

        SharePreviewCase.Files -> pairedState().copy(
            isLink = false,
            files = listOf(
                UploadAttachment(Uri.EMPTY, "photo.jpg", "image/jpeg", PREVIEW_PHOTO_BYTES),
                UploadAttachment(Uri.EMPTY, "notes.txt", "text/plain", PREVIEW_NOTE_BYTES)
            )
        )
    }
    Box(
        modifier = Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background),
        contentAlignment = Alignment.BottomCenter
    ) {
        ShareSheet(
            state = state,
            actions = ShareActions.None
        )
    }
}

private fun pairedState() = ShareUiState(
    mode = ShareMode.Ready,
    sharedText = SharedText(
        body = "https://example.com/dispatch-notes",
        title = "Dispatch notes"
    ),
    isLink = true,
    devices = listOf(
        ShareDevice(
            id = "019acd35-7a00-7000-8000-000000000001",
            name = "Pixel 9",
            online = true
        ),
        ShareDevice(
            id = "019acd35-7a00-7000-8000-000000000002",
            name = "Firefox on laptop",
            online = false
        )
    )
)

private const val PREVIEW_PHOTO_BYTES = 248_832L
private const val PREVIEW_NOTE_BYTES = 1_024L
