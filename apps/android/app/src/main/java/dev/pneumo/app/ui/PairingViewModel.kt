package dev.pneumo.app.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.pneumo.app.crypto.PairingData
import dev.pneumo.app.crypto.PairingUri
import dev.pneumo.app.data.KEY_MISMATCH_MESSAGE
import dev.pneumo.app.data.PairingKeyMismatchException
import dev.pneumo.app.data.PairingRepository
import dev.pneumo.app.net.ApiError
import java.io.IOException
import java.security.GeneralSecurityException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

enum class AppDestination {
    Loading,
    Pair,
    Confirm,
    Onboarding,
    Home
}

data class PairingState(
    val destination: AppDestination = AppDestination.Loading,
    val origin: String = "",
    val busy: Boolean = false,
    val error: String? = null,
    val retryable: Boolean = false
)

class PairingViewModel(private val pairingRepository: PairingRepository) : ViewModel() {
    private val mutableState = MutableStateFlow(PairingState())
    val state: StateFlow<PairingState> = mutableState.asStateFlow()

    private var pairingData: PairingData? = null
    private val restoreJob = restoreSession()

    fun openLink(value: String) {
        val current = mutableState.value
        if (
            current.busy ||
            (current.destination != AppDestination.Loading && current.destination != AppDestination.Pair)
        ) {
            return
        }
        restoreJob.cancel()
        val parsed = try {
            PairingUri.parse(value)
        } catch (_: IllegalArgumentException) {
            pairingData = null
            mutableState.value = PairingState(
                destination = AppDestination.Pair,
                error = INVALID_LINK_MESSAGE
            )
            return
        }
        pairingData = parsed
        mutableState.value = PairingState(
            destination = AppDestination.Confirm,
            origin = parsed.origin
        )
    }

    fun confirm() {
        if (mutableState.value.busy) return
        val pairing = pairingData ?: run {
            mutableState.value = PairingState(
                destination = AppDestination.Pair,
                error = INVALID_LINK_MESSAGE
            )
            return
        }
        mutableState.value = mutableState.value.copy(busy = true, error = null, retryable = false)
        viewModelScope.launch {
            try {
                restoreJob.join()
                val result = pairingRepository.pair(pairing)
                pairingData = null
                mutableState.value = PairingState(
                    destination = if (result.onboardingComplete) {
                        AppDestination.Home
                    } else {
                        AppDestination.Onboarding
                    },
                    origin = result.origin
                )
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (expected: PairingKeyMismatchException) {
                mutableState.value = mutableState.value.copy(
                    busy = false,
                    error = KEY_MISMATCH_MESSAGE,
                    retryable = expected.retryable
                )
            } catch (error: ApiError) {
                mutableState.value = mutableState.value.copy(
                    busy = false,
                    error = if (error.status == HTTP_GONE) EXPIRED_CODE_MESSAGE else PAIRING_FAILED_MESSAGE,
                    retryable = error.status >= HTTP_SERVER_ERROR
                )
            } catch (_: IOException) {
                mutableState.value = mutableState.value.copy(
                    busy = false,
                    error = NETWORK_ERROR_MESSAGE,
                    retryable = true
                )
            } catch (_: GeneralSecurityException) {
                showPairingFailure()
            } catch (_: IllegalArgumentException) {
                showPairingFailure()
            } catch (_: IllegalStateException) {
                showPairingFailure()
            }
        }
    }

    fun backToPair() {
        if (mutableState.value.busy) return
        if (pairingData == null) {
            mutableState.value = PairingState(destination = AppDestination.Pair)
            return
        }
        mutableState.value = mutableState.value.copy(busy = true, error = null, retryable = false)
        viewModelScope.launch {
            try {
                pairingRepository.abandonPairing()
                pairingData = null
                mutableState.value = PairingState(destination = AppDestination.Pair)
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (_: IOException) {
                mutableState.value = mutableState.value.copy(
                    busy = false,
                    error = NETWORK_ERROR_MESSAGE,
                    retryable = true
                )
            } catch (_: IllegalArgumentException) {
                showPairingFailure(retryable = true)
            } catch (_: IllegalStateException) {
                showPairingFailure(retryable = true)
            }
        }
    }

    fun signOut() {
        if (mutableState.value.busy) return
        mutableState.value = mutableState.value.copy(busy = true, error = null, retryable = false)
        viewModelScope.launch {
            try {
                pairingRepository.signOut()
                pairingData = null
                mutableState.value = PairingState(destination = AppDestination.Pair)
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (_: IOException) {
                mutableState.value = mutableState.value.copy(
                    busy = false,
                    error = SIGN_OUT_NETWORK_ERROR_MESSAGE,
                    retryable = true
                )
            } catch (_: GeneralSecurityException) {
                showSignOutFailure()
            } catch (_: IllegalArgumentException) {
                showSignOutFailure()
            } catch (_: IllegalStateException) {
                showSignOutFailure()
            }
        }
    }

    fun completeOnboarding() {
        if (mutableState.value.busy) return
        mutableState.value = mutableState.value.copy(busy = true, error = null, retryable = false)
        viewModelScope.launch {
            try {
                pairingRepository.completeOnboarding()
                mutableState.value = mutableState.value.copy(
                    destination = AppDestination.Home,
                    busy = false,
                    error = null,
                    retryable = false
                )
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (_: IOException) {
                showOnboardingFailure()
            } catch (_: IllegalStateException) {
                showOnboardingFailure()
            }
        }
    }

    private fun restoreSession(): Job = viewModelScope.launch {
        try {
            val restored = pairingRepository.restore()
            if (mutableState.value.destination != AppDestination.Loading) return@launch
            mutableState.value = if (restored == null) {
                PairingState(destination = AppDestination.Pair)
            } else {
                PairingState(
                    destination = if (restored.onboardingComplete) {
                        AppDestination.Home
                    } else {
                        AppDestination.Onboarding
                    },
                    origin = restored.origin
                )
            }
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (_: IOException) {
            showRestoreFailure()
        } catch (_: GeneralSecurityException) {
            showRestoreFailure()
        } catch (_: IllegalArgumentException) {
            showRestoreFailure()
        } catch (_: IllegalStateException) {
            showRestoreFailure()
        }
    }

    private fun showPairingFailure(retryable: Boolean = false) {
        mutableState.value = mutableState.value.copy(
            busy = false,
            error = PAIRING_FAILED_MESSAGE,
            retryable = retryable
        )
    }

    private fun showSignOutFailure() {
        mutableState.value = mutableState.value.copy(
            busy = false,
            error = SIGN_OUT_FAILED_MESSAGE,
            retryable = true
        )
    }

    private fun showOnboardingFailure() {
        mutableState.value = mutableState.value.copy(
            busy = false,
            error = ONBOARDING_FAILED_MESSAGE,
            retryable = true
        )
    }

    private fun showRestoreFailure() {
        if (mutableState.value.destination == AppDestination.Loading) {
            mutableState.value = PairingState(
                destination = AppDestination.Pair,
                error = RESTORE_FAILED_MESSAGE,
                retryable = true
            )
        }
    }

    private companion object {
        const val HTTP_GONE = 410
        const val HTTP_SERVER_ERROR = 500
        const val INVALID_LINK_MESSAGE =
            "Invalid pairing link. Make a new code in the web app and try again."
        const val EXPIRED_CODE_MESSAGE =
            "This code has expired. Make a new one in the web app."
        const val NETWORK_ERROR_MESSAGE =
            "Couldn't reach the server. Check your connection and try again."
        const val PAIRING_FAILED_MESSAGE =
            "Pairing failed. Make a new code in the web app and try again."
        const val SIGN_OUT_NETWORK_ERROR_MESSAGE =
            "Couldn't reach the server. Try signing out again."
        const val SIGN_OUT_FAILED_MESSAGE = "Sign out failed. Try again."
        const val ONBOARDING_FAILED_MESSAGE = "Couldn't save your choice. Try again."
        const val RESTORE_FAILED_MESSAGE =
            "Your saved session couldn't be restored. Pair this device again."
    }
}
