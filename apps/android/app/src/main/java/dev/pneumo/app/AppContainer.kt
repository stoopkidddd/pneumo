package dev.pneumo.app

import android.content.Context
import android.os.Build
import dev.pneumo.app.crypto.deriveKeys
import dev.pneumo.app.data.AppSession
import dev.pneumo.app.data.PairingApiFactory
import dev.pneumo.app.data.PairingRepository
import dev.pneumo.app.data.SecureCredentialStore
import dev.pneumo.app.data.SecureStore
import dev.pneumo.app.data.SessionCache
import dev.pneumo.app.data.SessionLifecycle
import dev.pneumo.app.data.SessionPreferences
import dev.pneumo.app.data.SyncPreferences
import dev.pneumo.app.data.db.PneumoDatabase
import dev.pneumo.app.data.db.SyncStateEntity
import dev.pneumo.app.net.AccountApi
import dev.pneumo.app.net.ApiClient
import dev.pneumo.app.net.DeviceApi
import dev.pneumo.app.net.ws.AndroidNetworkMonitor
import dev.pneumo.app.net.ws.ConnectionState
import dev.pneumo.app.net.ws.OkHttpWsTransport
import dev.pneumo.app.net.ws.WsClient
import dev.pneumo.app.net.ws.WsSessionConfig
import dev.pneumo.app.notify.PushNotifier
import dev.pneumo.app.service.ConnectionService
import dev.pneumo.app.sync.PushRepository
import dev.pneumo.app.sync.SyncEngine
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient

class AppContainer(context: Context) {
    private val applicationContext = context.applicationContext
    private val applicationScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val httpClient = OkHttpClient()
    private val credentials by lazy { SecureStore.create(applicationContext) }
    private val sessions by lazy { SessionPreferences.create(applicationContext) }
    private val cursor by lazy { SyncPreferences.create(applicationContext) }
    internal val database by lazy { PneumoDatabase.create(applicationContext) }
    private val cache = SessionCache()
    private var connectionJob: Job? = null
    private val mutableConnectionState = MutableStateFlow(ConnectionState.Offline)
    val connectionState = mutableConnectionState.asStateFlow()

    val pairingRepository: PairingRepository by lazy(LazyThreadSafetyMode.SYNCHRONIZED) {
        PairingRepository(
            apiFactory = RealPairingApiFactory(httpClient),
            credentialStore = SecureCredentialStore(credentials),
            sessionStore = sessions,
            lifecycle = object : SessionLifecycle {
                override suspend fun claimed(createdAt: String) {
                    database.syncState().put(SyncStateEntity(lastPushId = "", lastCreatedAt = createdAt))
                }

                override fun paired() {
                    ConnectionService.start(applicationContext)
                }

                override suspend fun cleared() {
                    connectionJob?.cancelAndJoin()
                    connectionJob = null
                    ConnectionService.stop(applicationContext)
                    cache.clear {
                        database.wipe()
                        cursor.clear()
                    }
                    mutableConnectionState.value = ConnectionState.Offline
                }
            },
            deviceName = { Build.MODEL.ifBlank { DEFAULT_DEVICE_NAME } }
        )
    }

    suspend fun openSession(): AppSession? {
        val generation = cache.generation()
        val metadata = sessions.read()
        val stored = credentials.read() ?: return null
        return try {
            val origin = metadata.origin
            val deviceId = metadata.deviceId
            if (origin == null || deviceId == null || cache.generation() != generation) {
                null
            } else {
                val contentKey = deriveKeys(stored.masterKey).contentKey
                AppSession(
                    api = ApiClient(origin, stored.token, httpClient),
                    pushes = PushRepository(database, contentKey),
                    contentKey = contentKey,
                    deviceId = deviceId,
                    cache = cache,
                    generation = generation
                )
            }
        } finally {
            stored.masterKey.fill(0)
        }
    }

    internal fun connect(scope: CoroutineScope) {
        if (connectionJob?.isActive == true) return
        connectionJob = scope.launch {
            val metadata = sessions.read()
            val stored = credentials.read()
            if (stored == null || metadata.origin == null || metadata.deviceId == null) {
                stored?.masterKey?.fill(0)
                ConnectionService.stop(applicationContext)
                return@launch
            }
            val contentKey = try {
                deriveKeys(stored.masterKey).contentKey
            } finally {
                stored.masterKey.fill(0)
            }
            val engine = SyncEngine(
                database,
                ApiClient(metadata.origin, stored.token, httpClient),
                cursor,
                metadata.deviceId,
                PushNotifier(applicationContext, metadata.deviceId, contentKey),
                cache
            )
            val network = AndroidNetworkMonitor(applicationContext)
            try {
                val client = WsClient(
                    transport = OkHttpWsTransport(metadata.origin, httpClient),
                    network = network,
                    session = WsSessionConfig(
                        token = stored.token,
                        version = BuildConfig.VERSION_NAME,
                        since = cursor::read
                    ),
                    onFrame = engine::apply,
                    onUnauthorized = {
                        applicationScope.launch { pairingRepository.revoke() }
                    }
                )
                coroutineScope {
                    val observer = launch { client.state.collect { mutableConnectionState.value = it } }
                    try {
                        client.run()
                    } finally {
                        observer.cancel()
                    }
                }
            } finally {
                network.close()
                mutableConnectionState.value = ConnectionState.Offline
            }
        }
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
