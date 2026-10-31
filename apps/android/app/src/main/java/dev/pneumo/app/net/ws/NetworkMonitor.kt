package dev.pneumo.app.net.ws

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

interface NetworkMonitor : AutoCloseable {
    val available: StateFlow<Boolean>

    override fun close()
}

class AndroidNetworkMonitor(context: Context) : NetworkMonitor {
    private val connectivityManager =
        context.applicationContext.getSystemService(ConnectivityManager::class.java)
    private val mutableAvailable = MutableStateFlow(connectivityManager.hasAvailableNetwork())
    private val closed = AtomicBoolean(false)
    private val callback =
        object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                mutableAvailable.value = connectivityManager.hasAvailableNetwork()
            }

            override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
                mutableAvailable.value = capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            }

            override fun onLost(network: Network) {
                mutableAvailable.value = connectivityManager.hasAvailableNetwork()
            }

            override fun onUnavailable() {
                mutableAvailable.value = false
            }
        }

    override val available: StateFlow<Boolean> = mutableAvailable.asStateFlow()

    init {
        connectivityManager.registerDefaultNetworkCallback(callback)
        mutableAvailable.value = connectivityManager.hasAvailableNetwork()
    }

    override fun close() {
        if (closed.compareAndSet(false, true)) {
            connectivityManager.unregisterNetworkCallback(callback)
        }
    }

    private fun ConnectivityManager.hasAvailableNetwork(): Boolean {
        val network = activeNetwork ?: return false
        return getNetworkCapabilities(network)
            ?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true
    }
}
