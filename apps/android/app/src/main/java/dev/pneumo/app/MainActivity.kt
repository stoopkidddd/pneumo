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
        handlePairingIntent(intent)
        setContent {
            PneumoTheme {
                PneumoNavHost(pairingViewModel)
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
            // Do not retain a URI containing MK in the activity's intent.
            incoming.data = null
        }
    }
}
