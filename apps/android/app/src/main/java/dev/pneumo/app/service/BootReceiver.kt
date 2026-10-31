package dev.pneumo.app.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import dev.pneumo.app.PneumoApp
import dev.pneumo.app.data.PairingRepository
import java.io.IOException
import java.security.GeneralSecurityException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

class BootReceiver internal constructor(
    private val repository: ((Context) -> PairingRepository),
    private val scope: CoroutineScope
) : BroadcastReceiver() {
    constructor() : this(
        { (it.applicationContext as PneumoApp).container.pairingRepository },
        CoroutineScope(Dispatchers.IO)
    )

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED && intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        val pending = goAsync()
        scope.launch {
            try {
                repository(context).restore()
            } catch (_: IOException) {
                // A later app launch can retry inaccessible local storage.
            } catch (_: GeneralSecurityException) {
                // Restore has already removed credentials that cannot be unwrapped.
            } catch (_: IllegalArgumentException) {
                // Invalid persisted credentials are handled by restore.
            } finally {
                pending.finish()
            }
        }
    }
}
