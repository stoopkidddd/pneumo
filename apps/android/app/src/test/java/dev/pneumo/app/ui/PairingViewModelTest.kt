package dev.pneumo.app.ui

import app.cash.turbine.test
import dev.pneumo.app.crypto.Base64Url
import dev.pneumo.app.crypto.PairingUri
import dev.pneumo.app.crypto.keyCheck
import dev.pneumo.app.data.CredentialStore
import dev.pneumo.app.data.KEY_MISMATCH_MESSAGE
import dev.pneumo.app.data.PairingApiFactory
import dev.pneumo.app.data.PairingRepository
import dev.pneumo.app.data.SecureStore
import dev.pneumo.app.data.SessionLifecycle
import dev.pneumo.app.data.SessionMetadata
import dev.pneumo.app.data.SessionStore
import dev.pneumo.app.net.AccountApi
import dev.pneumo.app.net.ApiError
import dev.pneumo.app.net.DeviceApi
import dev.pneumo.app.protocol.ClaimPairRequest
import dev.pneumo.app.protocol.ClaimPairResponse
import dev.pneumo.app.protocol.CreatePairResponse
import dev.pneumo.app.protocol.DeviceDTO
import dev.pneumo.app.protocol.Limits
import dev.pneumo.app.protocol.ListDevicesResponse
import dev.pneumo.app.protocol.MeResponse
import dev.pneumo.app.protocol.Platform
import dev.pneumo.app.protocol.UpdateDeviceRequest
import dev.pneumo.app.protocol.UploadMode
import java.io.IOException
import java.security.GeneralSecurityException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TestWatcher
import org.junit.runner.Description

@OptIn(ExperimentalCoroutinesApi::class)
class PairingViewModelTest {
    @get:Rule
    val mainDispatcherRule = MainDispatcherRule()

    @Test
    fun claimSuccessSavesCredentialsAndOpensOnboarding() = runTest(mainDispatcherRule.dispatcher) {
        val fixture = Fixture()
        val viewModel = fixture.viewModel()

        viewModel.state.test {
            assertEquals(AppDestination.Loading, awaitItem().destination)
            runCurrent()
            assertEquals(AppDestination.Pair, awaitItem().destination)
            viewModel.openLink(PAIRING_URI)
            assertEquals(PairingState(AppDestination.Confirm, ORIGIN), awaitItem())

            viewModel.confirm()
            assertTrue(awaitItem().busy)
            runCurrent()
            val paired = awaitItem()
            assertEquals(AppDestination.Onboarding, paired.destination)
            assertEquals(ORIGIN, paired.origin)
            assertEquals(1, fixture.api.claimCalls)
            assertEquals(SessionMetadata(ORIGIN, DEVICE_ID, false), fixture.sessions.metadata)
            assertTrue(fixture.credentials.savedMasterKey?.contentEquals(MASTER_KEY) == true)
            assertNotNull(fixture.credentials.savedToken)
        }
    }

    @Test
    fun keyMismatchDeletesOwnDeviceAndWipesLocalState() = runTest(mainDispatcherRule.dispatcher) {
        val fixture = Fixture(remoteMasterKey = ByteArray(KEY_BYTES) { 9 })
        val viewModel = fixture.viewModel()
        runCurrent()
        viewModel.openLink(PAIRING_URI)

        viewModel.state.test {
            assertEquals(AppDestination.Confirm, awaitItem().destination)
            viewModel.confirm()
            assertTrue(awaitItem().busy)
            runCurrent()
            val failed = awaitItem()
            assertEquals(AppDestination.Confirm, failed.destination)
            assertEquals(KEY_MISMATCH_MESSAGE, failed.error)
            assertEquals(listOf(DEVICE_ID), fixture.api.deletedDeviceIds)
            assertEquals(1, fixture.credentials.clearCalls)
            assertEquals(1, fixture.sessions.clearCalls)
            assertNull(fixture.credentials.savedToken)
        }
    }

    @Test
    fun mismatchDeleteFailureStillWipesAndKeepsCleanupRetryable() = runTest(mainDispatcherRule.dispatcher) {
        val fixture = Fixture(remoteMasterKey = ByteArray(KEY_BYTES) { 9 }).apply {
            api.deleteFailure = IOException("offline")
        }
        val viewModel = fixture.viewModel()
        runCurrent()
        viewModel.openLink(PAIRING_URI)

        viewModel.state.test {
            assertEquals(AppDestination.Confirm, awaitItem().destination)
            viewModel.confirm()
            assertTrue(awaitItem().busy)
            runCurrent()
            val pendingCleanup = awaitItem()
            assertEquals(KEY_MISMATCH_MESSAGE, pendingCleanup.error)
            assertTrue(pendingCleanup.retryable)
            assertEquals(1, fixture.credentials.clearCalls)
            assertEquals(1, fixture.sessions.clearCalls)

            fixture.api.deleteFailure = null
            viewModel.confirm()
            assertTrue(awaitItem().busy)
            runCurrent()
            val cleaned = awaitItem()
            assertEquals(KEY_MISMATCH_MESSAGE, cleaned.error)
            assertEquals(false, cleaned.retryable)
            assertEquals(listOf(DEVICE_ID), fixture.api.deletedDeviceIds)
        }
    }

    @Test
    fun goneClaimShowsExactExpiredMessage() = runTest(mainDispatcherRule.dispatcher) {
        val fixture = Fixture().apply {
            api.claimFailure = ApiError("gone", HTTP_GONE, "gone")
        }
        val viewModel = fixture.viewModel()
        runCurrent()
        viewModel.openLink(PAIRING_URI)

        viewModel.state.test {
            assertEquals(AppDestination.Confirm, awaitItem().destination)
            viewModel.confirm()
            assertTrue(awaitItem().busy)
            runCurrent()
            val failed = awaitItem()
            assertEquals("This code has expired. Make a new one in the web app.", failed.error)
            assertEquals(false, failed.retryable)
            assertEquals(1, fixture.api.claimCalls)
            assertEquals(0, fixture.api.meCalls)
        }
    }

    @Test
    fun retryAfterMeNetworkFailureDoesNotReclaimConsumedCode() = runTest(mainDispatcherRule.dispatcher) {
        val fixture = Fixture().apply { api.meFailuresRemaining = 1 }
        val viewModel = fixture.viewModel()
        runCurrent()
        viewModel.openLink(PAIRING_URI)

        viewModel.state.test {
            assertEquals(AppDestination.Confirm, awaitItem().destination)
            viewModel.confirm()
            assertTrue(awaitItem().busy)
            runCurrent()
            val failed = awaitItem()
            assertTrue(failed.retryable)
            assertEquals(1, fixture.api.claimCalls)
            assertEquals(1, fixture.api.meCalls)

            viewModel.confirm()
            assertTrue(awaitItem().busy)
            runCurrent()
            assertEquals(AppDestination.Onboarding, awaitItem().destination)
            assertEquals(1, fixture.api.claimCalls)
            assertEquals(2, fixture.api.meCalls)
        }
    }

    @Test
    fun replacementViewModelCanVerifyAnAlreadyClaimedCode() = runTest(mainDispatcherRule.dispatcher) {
        val fixture = Fixture().apply { api.meFailuresRemaining = 1 }
        val original = fixture.viewModel()
        runCurrent()
        original.openLink(PAIRING_URI)
        original.confirm()
        runCurrent()
        assertTrue(original.state.value.retryable)

        val replacement = fixture.viewModel()
        runCurrent()
        replacement.state.test {
            assertEquals(AppDestination.Pair, awaitItem().destination)
            replacement.openLink(PAIRING_URI)
            assertEquals(AppDestination.Confirm, awaitItem().destination)
            replacement.confirm()
            assertTrue(awaitItem().busy)
            runCurrent()
            assertEquals(AppDestination.Onboarding, awaitItem().destination)
            assertEquals(1, fixture.api.claimCalls)
            assertEquals(2, fixture.api.meCalls)
            assertTrue(fixture.credentials.savedMasterKey?.contentEquals(MASTER_KEY) == true)
        }
    }

    @Test
    fun replacementViewModelDeletesOldClaimBeforeClaimingNewCode() = runTest(mainDispatcherRule.dispatcher) {
        val fixture = Fixture().apply { api.meFailuresRemaining = 1 }
        val original = fixture.viewModel()
        runCurrent()
        original.openLink(PAIRING_URI)
        original.confirm()
        runCurrent()

        val replacement = fixture.viewModel()
        runCurrent()
        replacement.openLink(PairingUri.build(ORIGIN, Base64Url.encode(ByteArray(PAIR_CODE_BYTES) { 2 }), MASTER_KEY))
        replacement.confirm()
        runCurrent()
        assertEquals(AppDestination.Onboarding, replacement.state.value.destination)
        assertEquals(listOf(DEVICE_ID), fixture.api.deletedDeviceIds)
        assertEquals(2, fixture.api.claimCalls)
        assertTrue(fixture.credentials.savedMasterKey?.contentEquals(MASTER_KEY) == true)
    }

    @Test
    fun restoreAndOnboardingCompletionUsePersistedBoundaries() = runTest(mainDispatcherRule.dispatcher) {
        val fixture = Fixture(
            initialCredentials = SecureStore.Credentials(MASTER_KEY.copyOf(), TOKEN),
            initialMetadata = SessionMetadata(ORIGIN, DEVICE_ID, false)
        )
        val viewModel = fixture.viewModel()

        viewModel.state.test {
            assertEquals(AppDestination.Loading, awaitItem().destination)
            runCurrent()
            val restored = awaitItem()
            assertEquals(AppDestination.Onboarding, restored.destination)
            assertEquals(ORIGIN, restored.origin)

            viewModel.completeOnboarding()
            assertTrue(awaitItem().busy)
            runCurrent()
            assertEquals(AppDestination.Home, awaitItem().destination)
            assertTrue(fixture.sessions.metadata.onboardingComplete)
        }
    }

    @Test
    fun signOutFailureKeepsSessionUntilRemoteDeleteSucceeds() = runTest(mainDispatcherRule.dispatcher) {
        val fixture = Fixture(
            initialCredentials = SecureStore.Credentials(MASTER_KEY.copyOf(), TOKEN),
            initialMetadata = SessionMetadata(ORIGIN, DEVICE_ID, true)
        ).apply {
            api.deleteFailure = IOException("offline")
        }
        val viewModel = fixture.viewModel()
        runCurrent()

        viewModel.state.test {
            assertEquals(AppDestination.Home, awaitItem().destination)
            viewModel.signOut()
            assertTrue(awaitItem().busy)
            runCurrent()
            val failed = awaitItem()
            assertEquals(AppDestination.Home, failed.destination)
            assertTrue(failed.retryable)
            assertEquals(0, fixture.credentials.clearCalls)
            assertEquals(SessionMetadata(ORIGIN, DEVICE_ID, true), fixture.sessions.metadata)

            fixture.api.deleteFailure = null
            viewModel.signOut()
            assertTrue(awaitItem().busy)
            runCurrent()
            assertEquals(AppDestination.Pair, awaitItem().destination)
            assertEquals(1, fixture.credentials.clearCalls)
            assertNull(fixture.sessions.metadata.origin)
            assertNull(fixture.sessions.metadata.deviceId)
            assertTrue(fixture.sessions.metadata.onboardingComplete)
        }
    }

    @Test
    fun signOutTreatsRevokedTokenAsAlreadyDeleted() = runTest(mainDispatcherRule.dispatcher) {
        val fixture = Fixture(
            initialCredentials = SecureStore.Credentials(MASTER_KEY.copyOf(), TOKEN),
            initialMetadata = SessionMetadata(ORIGIN, DEVICE_ID, true)
        ).apply {
            api.deleteFailure = ApiError.Unauthorized()
        }
        val viewModel = fixture.viewModel()
        runCurrent()

        viewModel.signOut()
        runCurrent()

        assertEquals(AppDestination.Pair, viewModel.state.value.destination)
        assertEquals(1, fixture.credentials.clearCalls)
        assertNull(fixture.sessions.metadata.origin)
    }

    @Test
    fun storedSessionTakesPrecedenceOverLinkOpenedDuringRestore() = runTest(mainDispatcherRule.dispatcher) {
        val fixture = Fixture(
            initialCredentials = SecureStore.Credentials(MASTER_KEY.copyOf(), TOKEN),
            initialMetadata = SessionMetadata(ORIGIN, DEVICE_ID, true)
        )
        fixture.credentials.readGate = CompletableDeferred()
        val viewModel = fixture.viewModel()
        runCurrent()

        viewModel.openLink(PairingUri.build("https://foreign.example.com", CODE, MASTER_KEY))
        runCurrent()
        assertEquals(AppDestination.Loading, viewModel.state.value.destination)
        fixture.credentials.readGate?.complete(Unit)
        runCurrent()

        assertEquals(PairingState(AppDestination.Home, ORIGIN), viewModel.state.value)
        assertEquals(SessionMetadata(ORIGIN, DEVICE_ID, true), fixture.sessions.metadata)
        assertEquals(0, fixture.credentials.clearCalls)
        assertEquals(0, fixture.api.claimCalls)
    }

    @Test
    fun unpairedLinkWaitsForRestoreBeforeOpeningConfirm() = runTest(mainDispatcherRule.dispatcher) {
        val fixture = Fixture()
        fixture.credentials.readGate = CompletableDeferred()
        val viewModel = fixture.viewModel()
        runCurrent()
        assertTrue(fixture.credentials.readStarted.isCompleted)

        viewModel.openLink(PAIRING_URI)
        runCurrent()
        assertEquals(AppDestination.Loading, viewModel.state.value.destination)
        fixture.credentials.readGate?.complete(Unit)
        runCurrent()
        assertEquals(PairingState(AppDestination.Confirm, ORIGIN), viewModel.state.value)

        viewModel.confirm()
        runCurrent()
        assertEquals(AppDestination.Onboarding, viewModel.state.value.destination)
        assertEquals(SessionMetadata(ORIGIN, DEVICE_ID, false), fixture.sessions.metadata)
        assertNotNull(fixture.credentials.savedToken)
    }

    @Test
    fun corruptSessionBecomesActionablePairState() = runTest(mainDispatcherRule.dispatcher) {
        val fixture = Fixture().apply {
            credentials.readFailure = GeneralSecurityException("corrupt")
        }
        val viewModel = fixture.viewModel()

        viewModel.state.test {
            assertEquals(AppDestination.Loading, awaitItem().destination)
            runCurrent()
            val recovered = awaitItem()
            assertEquals(AppDestination.Pair, recovered.destination)
            assertNotNull(recovered.error)
            assertTrue(recovered.retryable)
            assertEquals(1, fixture.credentials.clearCalls)
        }
    }

    @Test
    fun revokedSessionWipesAndReturnsToPairWithoutServerDelete() = runTest(mainDispatcherRule.dispatcher) {
        val fixture = Fixture(
            initialCredentials = SecureStore.Credentials(MASTER_KEY.copyOf(), TOKEN),
            initialMetadata = SessionMetadata(ORIGIN, DEVICE_ID, true)
        )
        val viewModel = fixture.viewModel()
        runCurrent()
        assertEquals(AppDestination.Home, viewModel.state.value.destination)
        assertEquals(1, fixture.lifecycle.starts)

        viewModel.state.test {
            awaitItem()
            fixture.repository.revoke()
            runCurrent()
            assertEquals(AppDestination.Pair, awaitItem().destination)
        }
        assertNull(fixture.credentials.savedToken)
        assertEquals(SessionMetadata(null, null, true), fixture.sessions.metadata)
        assertEquals(1, fixture.credentials.clearCalls)
        assertEquals(1, fixture.lifecycle.clears)
        assertTrue(fixture.api.deletedDeviceIds.isEmpty())
    }

    private class Fixture(
        remoteMasterKey: ByteArray = MASTER_KEY,
        initialCredentials: SecureStore.Credentials? = null,
        initialMetadata: SessionMetadata = SessionMetadata(null, null, false)
    ) {
        val credentials = FakeCredentialStore(initialCredentials)
        val sessions = FakeSessionStore(initialMetadata)
        val api = FakePairingApiFactory(remoteMasterKey)

        val lifecycle = FakeSessionLifecycle()
        val repository = PairingRepository(api, credentials, sessions, lifecycle) { "Fixed test phone" }

        fun viewModel(): PairingViewModel = PairingViewModel(repository)
    }

    private class FakeSessionLifecycle : SessionLifecycle {
        var starts = 0
        var clears = 0

        override fun paired() {
            starts += 1
        }

        override suspend fun cleared() {
            clears += 1
        }
    }
    private class FakeCredentialStore(initial: SecureStore.Credentials?) : CredentialStore {
        private var credentials = initial
        var savedMasterKey: ByteArray? = null
        var savedToken: String? = null
        var clearCalls = 0
        var readFailure: Exception? = null
        var readGate: CompletableDeferred<Unit>? = null
        val readStarted = CompletableDeferred<Unit>()

        override suspend fun read(): SecureStore.Credentials? {
            readStarted.complete(Unit)
            readGate?.await()
            readFailure?.let { throw it }
            return credentials?.let { SecureStore.Credentials(it.masterKey.copyOf(), it.token) }
        }

        override suspend fun save(masterKey: ByteArray, token: String) {
            savedMasterKey = masterKey.copyOf()
            savedToken = token
            credentials = SecureStore.Credentials(masterKey.copyOf(), token)
        }

        override suspend fun clear() {
            clearCalls += 1
            credentials?.masterKey?.fill(0)
            credentials = null
            savedMasterKey?.fill(0)
            savedMasterKey = null
            savedToken = null
        }
    }

    private class FakeSessionStore(initial: SessionMetadata) : SessionStore {
        var metadata = initial
        var clearCalls = 0

        override suspend fun read(): SessionMetadata = metadata

        override suspend fun saveSession(origin: String, deviceId: String) {
            metadata = metadata.copy(origin = origin, deviceId = deviceId)
        }

        override suspend fun completeOnboarding() {
            metadata = metadata.copy(onboardingComplete = true)
        }

        override suspend fun clearSession() {
            clearCalls += 1
            metadata = metadata.copy(origin = null, deviceId = null)
        }
    }

    private class FakePairingApiFactory(remoteMasterKey: ByteArray) : PairingApiFactory {
        private val remoteCheck = Base64Url.encode(keyCheck(remoteMasterKey))
        var claimCalls = 0
        var meCalls = 0
        var meFailuresRemaining = 0
        var claimFailure: ApiError? = null
        var deleteFailure: IOException? = null
        val deletedDeviceIds = mutableListOf<String>()

        override fun account(origin: String, bearerToken: String?): AccountApi = object : AccountApi {
            override suspend fun me(): MeResponse {
                meCalls += 1
                if (meFailuresRemaining > 0) {
                    meFailuresRemaining -= 1
                    throw IOException("offline")
                }
                return meResponse(remoteCheck)
            }

            override suspend fun createPair(): CreatePairResponse = error("Not used")

            override suspend fun claimPair(request: ClaimPairRequest): ClaimPairResponse {
                claimCalls += 1
                claimFailure?.let { throw it }
                return ClaimPairResponse(device(), TOKEN)
            }
        }

        override fun devices(origin: String, bearerToken: String): DeviceApi = object : DeviceApi {
            override suspend fun listDevices(): ListDevicesResponse = error("Not used")

            override suspend fun updateDevice(id: String, request: UpdateDeviceRequest): DeviceDTO = error("Not used")

            override suspend fun deleteDevice(id: String) {
                deleteFailure?.let { throw it }
                deletedDeviceIds += id
            }
        }
    }

    private companion object {
        const val KEY_BYTES = 32
        const val PAIR_CODE_BYTES = 16
        const val HTTP_GONE = 410
        const val ORIGIN = "https://pneumo.example.com"
        const val DEVICE_ID = "018f0c6e-7a00-7000-8000-000000000001"
        const val TIMESTAMP = "2026-10-30T12:00:00.000Z"
        val MASTER_KEY = ByteArray(KEY_BYTES) { 1 }
        val TOKEN = Base64Url.encode(ByteArray(KEY_BYTES) { 2 })
        val CODE = Base64Url.encode(ByteArray(PAIR_CODE_BYTES) { 3 })
        val PUBLIC_KEY = Base64Url.encode(ByteArray(65) { 4 })
        val PAIRING_URI = PairingUri.build(ORIGIN, CODE, MASTER_KEY)

        fun device(): DeviceDTO = DeviceDTO(
            name = "Fixed test phone",
            platform = Platform.ANDROID,
            id = DEVICE_ID,
            createdAt = TIMESTAMP,
            lastSeenAt = TIMESTAMP,
            online = true
        )

        fun meResponse(encodedCheck: String): MeResponse = MeResponse(
            device = device(),
            keyCheck = encodedCheck,
            limits = Limits(maxFileBytes = 1, maxEnvelopeBytes = 1),
            vapidPublicKey = PUBLIC_KEY,
            uploadMode = UploadMode.AUTO
        )
    }
}

@OptIn(ExperimentalCoroutinesApi::class)
class MainDispatcherRule(val dispatcher: TestDispatcher = StandardTestDispatcher()) : TestWatcher() {
    override fun starting(description: Description) {
        Dispatchers.setMain(dispatcher)
    }

    override fun finished(description: Description) {
        Dispatchers.resetMain()
    }
}
