package dev.pneumo.app.data

import dev.pneumo.app.crypto.Base64Url
import dev.pneumo.app.crypto.PairingData
import dev.pneumo.app.crypto.keyCheck
import dev.pneumo.app.net.AccountApi
import dev.pneumo.app.net.ApiError
import dev.pneumo.app.net.DeviceApi
import dev.pneumo.app.protocol.ClaimPairRequest
import dev.pneumo.app.protocol.DeviceInput
import dev.pneumo.app.protocol.Platform
import java.io.IOException
import java.security.GeneralSecurityException
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext

internal const val KEY_MISMATCH_MESSAGE =
    "This QR code's key doesn't match the server. Make a new code and scan again."

internal class PairingKeyMismatchException(val retryable: Boolean = false, cause: IOException? = null) :
    IOException(KEY_MISMATCH_MESSAGE, cause)

internal data class RestoredSession(val origin: String, val onboardingComplete: Boolean)

internal data class PairingOutcome(val origin: String, val onboardingComplete: Boolean)

internal interface CredentialStore {
    suspend fun read(): SecureStore.Credentials?

    suspend fun save(masterKey: ByteArray, token: String)

    suspend fun clear()
}

internal class SecureCredentialStore(private val secureStore: SecureStore) : CredentialStore {
    override suspend fun read(): SecureStore.Credentials? = secureStore.read()

    override suspend fun save(masterKey: ByteArray, token: String) {
        secureStore.save(masterKey, token)
    }

    override suspend fun clear() {
        secureStore.clear()
    }
}

internal interface PairingApiFactory {
    fun account(origin: String, bearerToken: String?): AccountApi

    fun devices(origin: String, bearerToken: String): DeviceApi
}

class PairingRepository internal constructor(
    private val apiFactory: PairingApiFactory,
    private val credentialStore: CredentialStore,
    private val sessionStore: SessionStore,
    private val deviceName: () -> String
) {
    private val pendingClaim = AtomicReference<PendingClaim?>()

    internal suspend fun restore(): RestoredSession? {
        val metadata = sessionStore.read()
        val credentials = try {
            credentialStore.read()
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (expected: IOException) {
            recoverFailedRestore(expected)
        } catch (expected: GeneralSecurityException) {
            recoverFailedRestore(expected)
        } catch (expected: IllegalArgumentException) {
            recoverFailedRestore(expected)
        }

        credentials?.masterKey?.fill(0)
        val hasCompleteMetadata = metadata.origin != null && metadata.deviceId != null
        return when {
            credentials == null && !hasCompleteMetadata -> {
                if (metadata.origin != null || metadata.deviceId != null) {
                    withContext(NonCancellable) { sessionStore.clearSession() }
                }
                null
            }

            credentials == null || !hasCompleteMetadata -> {
                withContext(NonCancellable) { clearLocalState() }
                null
            }

            else -> RestoredSession(
                origin = checkNotNull(metadata.origin),
                onboardingComplete = metadata.onboardingComplete
            )
        }
    }

    internal suspend fun pair(pairing: PairingData): PairingOutcome {
        val previous = pendingClaim.get()
        if (previous != null && (previous.origin != pairing.origin || previous.code != pairing.code)) {
            abandonPairing()
        }
        val pending = pendingClaim.get() ?: claim(pairing).also { pendingClaim.set(it) }

        if (pending.keyMismatch) {
            finishMismatchCleanup(pending)
        }
        val response = apiFactory.account(pending.origin, pending.token).me()
        if (!matchesKeyCheck(pairing, response.keyCheck)) {
            pending.keyMismatch = true
            finishMismatchCleanup(pending)
        }

        val masterKey = pairing.mk
        try {
            credentialStore.save(masterKey, pending.token)
        } finally {
            masterKey.fill(0)
        }
        sessionStore.saveSession(pending.origin, pending.deviceId)
        val onboardingComplete = sessionStore.read().onboardingComplete
        pendingClaim.compareAndSet(pending, null)
        return PairingOutcome(pending.origin, onboardingComplete)
    }

    internal suspend fun abandonPairing() {
        val pending = pendingClaim.get() ?: return
        withContext(NonCancellable) {
            deleteOwnDevice(pending.origin, pending.token, pending.deviceId)
            clearLocalState()
            pendingClaim.compareAndSet(pending, null)
        }
    }

    internal suspend fun completeOnboarding() {
        sessionStore.completeOnboarding()
    }

    internal suspend fun signOut() {
        val metadata = sessionStore.read()
        val credentials = credentialStore.read()
        if (credentials == null || metadata.origin == null || metadata.deviceId == null) {
            credentials?.masterKey?.fill(0)
            withContext(NonCancellable) { clearLocalState() }
            return
        }
        try {
            deleteOwnDevice(metadata.origin, credentials.token, metadata.deviceId)
        } finally {
            credentials.masterKey.fill(0)
        }
        withContext(NonCancellable) { clearLocalState() }
    }

    private suspend fun claim(pairing: PairingData): PendingClaim {
        val response = apiFactory.account(pairing.origin, null).claimPair(
            ClaimPairRequest(
                code = pairing.code,
                device = DeviceInput(name = deviceName(), platform = Platform.ANDROID)
            )
        )
        return PendingClaim(
            code = pairing.code,
            origin = pairing.origin,
            deviceId = response.device.id,
            token = response.token
        )
    }

    private suspend fun finishMismatchCleanup(pending: PendingClaim): Nothing {
        var deletionFailure: IOException? = null
        var cleanupFailure: IOException? = null
        withContext(NonCancellable) {
            try {
                deleteOwnDevice(pending.origin, pending.token, pending.deviceId)
            } catch (expected: IOException) {
                deletionFailure = expected
            }
            try {
                clearLocalState()
            } catch (expected: IOException) {
                cleanupFailure = expected
            }
            if (deletionFailure == null && cleanupFailure == null) {
                pendingClaim.compareAndSet(pending, null)
            }
        }
        val failure = deletionFailure ?: cleanupFailure
        throw PairingKeyMismatchException(
            retryable = failure != null,
            cause = failure
        )
    }

    private suspend fun deleteOwnDevice(origin: String, token: String, deviceId: String) {
        try {
            apiFactory.devices(origin, token).deleteDevice(deviceId)
        } catch (expected: ApiError) {
            if (expected.status != ApiError.HTTP_UNAUTHORIZED && expected.status != HTTP_NOT_FOUND) {
                throw expected
            }
        }
    }

    private suspend fun recoverFailedRestore(expected: Exception): Nothing {
        withContext(NonCancellable) { clearLocalState() }
        throw expected
    }

    private suspend fun clearLocalState() {
        var failure: IOException? = null
        try {
            credentialStore.clear()
        } catch (expected: IOException) {
            failure = expected
        }
        try {
            sessionStore.clearSession()
        } catch (expected: IOException) {
            val firstFailure = failure
            if (firstFailure == null) {
                failure = expected
            } else {
                firstFailure.addSuppressed(expected)
            }
        }
        failure?.let { throw it }
    }

    private companion object {
        const val HTTP_NOT_FOUND = 404
    }

    private class PendingClaim(
        val code: String,
        val origin: String,
        val deviceId: String,
        val token: String,
        var keyMismatch: Boolean = false
    ) {
        override fun toString(): String = "PendingClaim([redacted])"
    }
}
private fun matchesKeyCheck(pairing: PairingData, encodedRemoteCheck: String): Boolean {
    val masterKey = pairing.mk
    val localCheck = try {
        keyCheck(masterKey)
    } finally {
        masterKey.fill(0)
    }
    val remoteCheck = Base64Url.decode(encodedRemoteCheck)
    return try {
        MessageDigest.isEqual(localCheck, remoteCheck)
    } finally {
        localCheck.fill(0)
        remoteCheck.fill(0)
    }
}
