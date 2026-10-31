package dev.pneumo.app

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Looper
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import dev.pneumo.app.crypto.Base64Url
import dev.pneumo.app.crypto.PairingUri
import dev.pneumo.app.data.CredentialStore
import dev.pneumo.app.data.PairingApiFactory
import dev.pneumo.app.data.PairingRepository
import dev.pneumo.app.data.SecureStore
import dev.pneumo.app.data.SessionMetadata
import dev.pneumo.app.data.SessionStore
import dev.pneumo.app.net.AccountApi
import dev.pneumo.app.net.DeviceApi
import dev.pneumo.app.ui.AppDestination
import dev.pneumo.app.ui.PairingState
import dev.pneumo.app.ui.PairingViewModel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.android.controller.ActivityController
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PairingIntentTest {
    @Test
    fun deepLinkOpensConfirmWithoutRetainingKeyInIntent() {
        activity(pairingIntent()).setup().use { controller ->
            shadowOf(Looper.getMainLooper()).idle()
            val state = controller.get().pairingViewModel.state.value
            assertEquals(PairingState(AppDestination.Confirm, LINK_ORIGIN), state)
            assertEquals(Intent.ACTION_MAIN, controller.get().intent.action)
            assertNull(controller.get().intent.data)
        }
    }

    @Test
    fun invalidDeepLinkShowsRecoveryInsteadOfConfirm() {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse("pneumo://pair?v=1&u=https%3A%2F%2Fpneumo.example.com"))
        activity(intent).setup().use { controller ->
            shadowOf(Looper.getMainLooper()).idle()
            val state = controller.get().pairingViewModel.state.value
            assertEquals(AppDestination.Pair, state.destination)
            assertEquals("Invalid pairing link. Make a new code in the web app and try again.", state.error)
        }
    }

    @Test
    fun consumedLinkDoesNotBecomeAnErrorWhenPairIsRecreated() {
        activity(pairingIntent()).setup().use { controller ->
            shadowOf(Looper.getMainLooper()).idle()
            controller.get().pairingViewModel.backToPair()
            shadowOf(Looper.getMainLooper()).idle()
            controller.recreate()
            shadowOf(Looper.getMainLooper()).idle()
            assertEquals(PairingState(AppDestination.Pair), controller.get().pairingViewModel.state.value)
        }
    }

    @Test
    fun savedTaskRestoresSessionWithoutReplayingOriginalViewIntent() {
        val fixture = SessionFixture(paired = true)
        val savedState = Bundle()
        activity(Intent(Intent.ACTION_MAIN), fixture).setup().use { controller ->
            shadowOf(Looper.getMainLooper()).idle()
            assertEquals(
                PairingState(AppDestination.Home, SESSION_ORIGIN),
                controller.get().pairingViewModel.state.value
            )
            controller.saveInstanceState(savedState)
        }
        activity(pairingIntent(), fixture).setup(savedState).use { controller ->
            shadowOf(Looper.getMainLooper()).idle()
            assertEquals(
                PairingState(AppDestination.Home, SESSION_ORIGIN),
                controller.get().pairingViewModel.state.value
            )
            assertEquals(Intent.ACTION_MAIN, controller.get().intent.action)
            assertNull(controller.get().intent.data)
        }
    }

    @Test
    fun historyLaunchRestoresSessionWithoutReplayingViewIntent() {
        val intent = pairingIntent().addFlags(Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY)
        activity(intent, SessionFixture(paired = true)).setup().use { controller ->
            shadowOf(Looper.getMainLooper()).idle()
            assertEquals(
                PairingState(AppDestination.Home, SESSION_ORIGIN),
                controller.get().pairingViewModel.state.value
            )
            assertEquals(Intent.ACTION_MAIN, controller.get().intent.action)
        }
    }

    @Test
    fun coldAndWarmForeignLinksCannotReplaceStoredSession() {
        activity(pairingIntent(), SessionFixture(paired = true)).setup().use { controller ->
            shadowOf(Looper.getMainLooper()).idle()
            assertEquals(
                PairingState(AppDestination.Home, SESSION_ORIGIN),
                controller.get().pairingViewModel.state.value
            )
            controller.newIntent(pairingIntent())
            shadowOf(Looper.getMainLooper()).idle()
            assertEquals(
                PairingState(AppDestination.Home, SESSION_ORIGIN),
                controller.get().pairingViewModel.state.value
            )
        }
    }

    private fun activity(
        intent: Intent,
        fixture: SessionFixture = SessionFixture(paired = false)
    ): ActivityController<MainActivity> {
        val controller = Robolectric.buildActivity(MainActivity::class.java, intent)
        ViewModelProvider(
            controller.get(),
            viewModelFactory { initializer { PairingViewModel(fixture.repository) } }
        )[PairingViewModel::class.java]
        return controller
    }

    private class SessionFixture(paired: Boolean) {
        private val credentials = object : CredentialStore {
            override suspend fun read(): SecureStore.Credentials? = if (paired) {
                SecureStore.Credentials(ByteArray(KEY_BYTES), Base64Url.encode(ByteArray(KEY_BYTES)))
            } else {
                null
            }

            override suspend fun save(masterKey: ByteArray, token: String): Unit = error("Session must not be replaced")

            override suspend fun clear(): Unit = error("Session must not be cleared")
        }
        private val sessions = object : SessionStore {
            override suspend fun read(): SessionMetadata = if (paired) {
                SessionMetadata(SESSION_ORIGIN, DEVICE_ID, true)
            } else {
                SessionMetadata(null, null, false)
            }

            override suspend fun saveSession(origin: String, deviceId: String): Unit =
                error("Session must not be replaced")

            override suspend fun completeOnboarding(): Unit = error("Onboarding must not run")

            override suspend fun clearSession(): Unit = error("Session must not be cleared")
        }
        private val api = object : PairingApiFactory {
            override fun account(origin: String, bearerToken: String?): AccountApi = error("Unexpected network request")

            override fun devices(origin: String, bearerToken: String): DeviceApi = error("Unexpected network request")
        }
        val repository = PairingRepository(api, credentials, sessions) { "Fixed test phone" }
    }

    private companion object {
        const val KEY_BYTES = 32
        const val LINK_ORIGIN = "https://foreign.example.com:8443"
        const val SESSION_ORIGIN = "https://pneumo.example.com"
        const val DEVICE_ID = "0192e7ce-7c00-7000-8000-000000000001"

        fun pairingIntent(): Intent {
            val uri = PairingUri.build(LINK_ORIGIN, "AAAAAAAAAAAAAAAAAAAAAA", ByteArray(KEY_BYTES))
            return Intent(Intent.ACTION_VIEW, Uri.parse(uri))
        }
    }
}
