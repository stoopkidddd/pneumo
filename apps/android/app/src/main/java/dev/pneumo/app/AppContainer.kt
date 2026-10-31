package dev.pneumo.app

import android.content.Context
import android.os.Build
import dev.pneumo.app.data.PairingApiFactory
import dev.pneumo.app.data.PairingRepository
import dev.pneumo.app.data.SecureCredentialStore
import dev.pneumo.app.data.SecureStore
import dev.pneumo.app.data.SessionPreferences
import dev.pneumo.app.net.AccountApi
import dev.pneumo.app.net.ApiClient
import dev.pneumo.app.net.DeviceApi
import okhttp3.OkHttpClient

class AppContainer(context: Context) {
    private val applicationContext = context.applicationContext

    val pairingRepository: PairingRepository by lazy(LazyThreadSafetyMode.SYNCHRONIZED) {
        val httpClient = OkHttpClient()
        PairingRepository(
            apiFactory = RealPairingApiFactory(httpClient),
            credentialStore = SecureCredentialStore(SecureStore.create(applicationContext)),
            sessionStore = SessionPreferences.create(applicationContext),
            deviceName = { Build.MODEL.ifBlank { DEFAULT_DEVICE_NAME } }
        )
    }

    private class RealPairingApiFactory(private val httpClient: OkHttpClient) : PairingApiFactory {
        override fun account(origin: String, bearerToken: String?): AccountApi =
            ApiClient(origin, bearerToken, httpClient)

        override fun devices(origin: String, bearerToken: String): DeviceApi =
            ApiClient(origin, bearerToken, httpClient)
    }

    private companion object {
        const val DEFAULT_DEVICE_NAME = "Android device"
    }
}
