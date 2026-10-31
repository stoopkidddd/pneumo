package dev.pneumo.app

import android.content.Intent
import android.net.Uri
import dev.pneumo.app.crypto.PairingUri
import dev.pneumo.app.ui.AppDestination
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PairingIntentTest {
    @Test
    fun deepLinkOpensConfirmWithoutRetainingKeyInIntent() {
        val uri = PairingUri.build("https://pneumo.example.com:8443", "AAAAAAAAAAAAAAAAAAAAAA", ByteArray(32))
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(uri))
        Robolectric.buildActivity(MainActivity::class.java, intent).setup().use { controller ->
            val state = controller.get().pairingViewModel.state.value
            assertEquals(AppDestination.Confirm, state.destination)
            assertEquals("https://pneumo.example.com:8443", state.origin)
            assertNull(state.error)
            assertNull(controller.get().intent.data)
        }
    }

    @Test
    fun invalidDeepLinkShowsRecoveryInsteadOfConfirm() {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse("pneumo://pair?v=1&u=https%3A%2F%2Fpneumo.example.com"))
        Robolectric.buildActivity(MainActivity::class.java, intent).setup().use { controller ->
            val state = controller.get().pairingViewModel.state.value
            assertEquals(AppDestination.Pair, state.destination)
            assertEquals("Invalid pairing link. Make a new code in the web app and try again.", state.error)
        }
    }
}
