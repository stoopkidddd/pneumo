package dev.pneumo.app

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import dev.pneumo.app.ui.PairingViewModel
import dev.pneumo.app.ui.PneumoNavHost
import dev.pneumo.app.ui.theme.PneumoTheme

class MainActivity : ComponentActivity() {
    internal val pairingViewModel: PairingViewModel by lazy {
        ViewModelProvider(
            this,
            viewModelFactory {
                initializer { PairingViewModel((application as PneumoApp).container.pairingRepository) }
            }
        )[PairingViewModel::class.java]
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        if (savedInstanceState == null && intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY == 0) {
            handlePairingIntent(intent)
        } else {
            setIntent(
                Intent(intent).apply {
                    action = Intent.ACTION_MAIN
                    data = null
                }
            )
        }
        setContent {
            PneumoTheme {
                PneumoNavHost(pairingViewModel, (application as PneumoApp).container.connectionState)
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handlePairingIntent(intent)
    }

    private fun handlePairingIntent(incoming: Intent) {
        if (incoming.action == Intent.ACTION_VIEW) {
            pairingViewModel.openLink(incoming.dataString.orEmpty())
        }
        // Preserve launch identity, but never replay a consumed VIEW action or URI.
        setIntent(
            Intent(intent).apply {
                action = Intent.ACTION_MAIN
                data = null
            }
        )
    }
}
