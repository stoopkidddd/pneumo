package dev.pneumo.app

import android.content.Intent
import android.net.Uri
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.pneumo.app.crypto.PairingUri
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class MainActivityTest {
    @get:Rule
    val compose = createAndroidComposeRule<MainActivity>()

    @Test
    fun launchShowsPairingEntry() {
        compose.onNodeWithText("Pair with your Pneumo server").assertIsDisplayed()
    }

    @Test
    fun deepLinkShowsServerHost() {
        val uri = PairingUri.build("https://pneumo.example.com:8443", "AAAAAAAAAAAAAAAAAAAAAA", ByteArray(32))
        compose.activityRule.scenario.onActivity { activity ->
            activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(uri), activity, MainActivity::class.java))
        }
        compose.onNodeWithText("Pair with pneumo.example.com:8443?").assertIsDisplayed()
    }

    @Test
    fun invalidDeepLinkShowsRecovery() {
        compose.activityRule.scenario.onActivity { activity ->
            activity.startActivity(
                Intent(Intent.ACTION_VIEW, Uri.parse("pneumo://pair?invalid"), activity, MainActivity::class.java)
            )
        }
        compose.onNodeWithText(
            "Invalid pairing link. Make a new code in the web app and try again."
        ).assertIsDisplayed()
    }
}
