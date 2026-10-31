package dev.pneumo.app.transfer

import android.app.Notification
import android.content.Context
import android.content.res.Configuration
import android.widget.FrameLayout
import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.tooling.preview.PreviewParameter
import androidx.compose.ui.tooling.preview.PreviewParameterProvider
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.net.toUri
import dev.pneumo.app.ui.theme.PneumoTheme

enum class TransferNotificationCase(val fileName: String) {
    Uploading("transfer-notification-uploading"),
    Downloading("transfer-notification-downloading"),
    Done("transfer-notification-done"),
    Failed("transfer-notification-failed")
}

internal class TransferNotificationProvider : PreviewParameterProvider<TransferNotificationCase> {
    override val values: Sequence<TransferNotificationCase> = TransferNotificationCase.entries.asSequence()
}

@Preview(name = "Light", widthDp = 360, heightDp = 260)
@Preview(name = "Dark", widthDp = 360, heightDp = 260, uiMode = Configuration.UI_MODE_NIGHT_YES)
@Composable
internal fun TransferNotificationPreview(
    @PreviewParameter(TransferNotificationProvider::class) fixture: TransferNotificationCase
) {
    PneumoTheme { TransferNotificationPreviewContent(fixture, darkTheme = isSystemInDarkTheme()) }
}

/** Renders Android's actual expanded notification template, not an imitation Compose card. */
@Composable
internal fun TransferNotificationPreviewContent(fixture: TransferNotificationCase, darkTheme: Boolean) {
    val context = LocalContext.current
    val currentConfiguration = LocalConfiguration.current
    val nativeContext = remember(context, currentConfiguration, darkTheme) {
        val configuration = Configuration(currentConfiguration).apply {
            uiMode = (uiMode and Configuration.UI_MODE_NIGHT_MASK.inv()) or
                if (darkTheme) Configuration.UI_MODE_NIGHT_YES else Configuration.UI_MODE_NIGHT_NO
        }
        context.createConfigurationContext(configuration)
    }
    Box(modifier = Modifier.background(MaterialTheme.colorScheme.background).padding(12.dp)) {
        AndroidView(
            // Standalone framework templates use a light palette; SystemUI applies its own shade palette at runtime.
            modifier = Modifier.fillMaxWidth().background(
                Color(nativeContext.getColor(android.R.color.background_light))
            ),
            factory = {
                FrameLayout(nativeContext).apply {
                    val builder = Notification.Builder.recoverBuilder(
                        nativeContext,
                        fixture.notification(nativeContext)
                    )
                        .setShowWhen(false)
                    val template = builder.createBigContentView() ?: builder.createContentView()
                    addView(template.apply(nativeContext, this))
                }
            }
        )
    }
}

private fun TransferNotificationCase.notification(context: Context): Notification {
    val notifications = DownloadNotifications(context, PREVIEW_PUSH_ID)
    return when (this) {
        TransferNotificationCase.Uploading -> UploadForeground(context, 1).info(PREVIEW_PROGRESS).notification

        TransferNotificationCase.Downloading -> notifications.downloading(PREVIEW_NAME, PREVIEW_PROGRESS)

        TransferNotificationCase.Done -> notifications.complete(
            PREVIEW_NAME,
            "content://downloads/1".toUri(),
            "application/pdf"
        )

        TransferNotificationCase.Failed -> notifications.failed(PREVIEW_NAME, DownloadWorker.CORRUPTED_FILE)
    }
}

private const val PREVIEW_PUSH_ID = "019a3a20-2000-7000-8000-000000000003"
private const val PREVIEW_NAME = "switchboard-plan.pdf"
private const val PREVIEW_PROGRESS = 42
