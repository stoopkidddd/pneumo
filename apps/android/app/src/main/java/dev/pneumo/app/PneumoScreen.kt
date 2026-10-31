package dev.pneumo.app

import android.content.res.Configuration
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.tooling.preview.Preview
import dev.pneumo.app.ui.theme.PneumoTheme

@Composable
fun PneumoScreen(modifier: Modifier = Modifier) {
    Surface(modifier = modifier.fillMaxSize()) {
        Box(
            modifier = Modifier.safeDrawingPadding(),
            contentAlignment = Alignment.Center
        ) {
            Text(
                text = stringResource(R.string.app_name),
                style = MaterialTheme.typography.headlineMedium
            )
        }
    }
}

@Preview(name = "Pneumo light", widthDp = 360, heightDp = 800)
@Composable
internal fun PneumoLightPreview() {
    PneumoTheme(darkTheme = false) {
        PneumoScreen()
    }
}

@Preview(name = "Pneumo dark", widthDp = 360, heightDp = 800, uiMode = Configuration.UI_MODE_NIGHT_YES)
@Composable
internal fun PneumoDarkPreview() {
    PneumoTheme(darkTheme = true) {
        PneumoScreen()
    }
}
