package dev.pneumo.app.ui.home

import app.cash.turbine.ReceiveTurbine
import app.cash.turbine.test
import dev.pneumo.app.crypto.PushCrypto
import dev.pneumo.app.net.ApiError
import dev.pneumo.app.protocol.CreatePushRequest
import dev.pneumo.app.protocol.DeviceDTO
import dev.pneumo.app.protocol.LinkPayload
import dev.pneumo.app.protocol.ListPushesResponse
import dev.pneumo.app.protocol.NotePayload
import dev.pneumo.app.protocol.Platform
import dev.pneumo.app.protocol.PushDTO
import dev.pneumo.app.protocol.PushPayload
import dev.pneumo.app.sync.DecryptedPush
import dev.pneumo.app.ui.MainDispatcherRule
import java.io.IOException
import javax.crypto.SecretKey
import javax.crypto.spec.SecretKeySpec
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class HomeViewModelTest {
    @get:Rule
    val mainDispatcherRule = MainDispatcherRule()

    @Test
    fun sendNoteEncryptsRequestAndStoresReturnedPush() = runTest(mainDispatcherRule.dispatcher) {
        val fixture = Fixture()
        val viewModel = fixture.viewModel()

        viewModel.state.test {
            awaitState { !it.loading }
            viewModel.updateComposerText("Meet at the north entrance")
            awaitState { it.composer.text.isNotEmpty() }
            viewModel.send()
            assertTrue(awaitState { it.composer.sending }.composer.sending)
            runCurrent()
            val sent = awaitState {
                !it.composer.sending && it.composer.text.isEmpty() && it.pushes.size == 1
            }

            val request = fixture.source.created.single()
            val payload = PushCrypto.decrypt(KEY, request.id, request.envelope) as NotePayload
            assertEquals("Meet at the north entrance", payload.body)
            assertNull(request.targetDeviceId)
            assertEquals(request.id, sent.pushes.single().push.id)
            cancelAndIgnoreRemainingEvents()
        }
    }

    @Test
    fun sendLinkUsesSelectedTargetAndExistingLinkRule() = runTest(mainDispatcherRule.dispatcher) {
        val fixture = Fixture(devices = listOf(OFFLINE_DEVICE, ONLINE_DEVICE))
        val viewModel = fixture.viewModel()

        viewModel.state.test {
            awaitState { !it.loading && it.devices.size == 2 }
            viewModel.selectTarget(ONLINE_DEVICE.id)
            awaitState { it.composer.targetDeviceId == ONLINE_DEVICE.id }
            viewModel.updateComposerText("  https://example.com/path?q=one  ")
            awaitState { it.composer.text.startsWith("  ") }
            viewModel.send()
            awaitState { it.composer.sending }
            runCurrent()
            awaitState { !it.composer.sending }

            val request = fixture.source.created.single()
            val payload = PushCrypto.decrypt(KEY, request.id, request.envelope) as LinkPayload
            assertEquals("https://example.com/path?q=one", payload.url)
            assertEquals(ONLINE_DEVICE.id, request.targetDeviceId)
            cancelAndIgnoreRemainingEvents()
        }
    }

    @Test
    fun failedSendRetainsDraftTargetAndShowsError() = runTest(mainDispatcherRule.dispatcher) {
        val fixture = Fixture(devices = listOf(ONLINE_DEVICE)).apply {
            source.createFailure = IOException("offline")
        }
        val viewModel = fixture.viewModel()

        viewModel.state.test {
            awaitState { !it.loading && it.devices.isNotEmpty() }
            viewModel.updateComposerText("Keep this draft")
            viewModel.selectTarget(ONLINE_DEVICE.id)
            awaitState { it.composer.targetDeviceId != null && it.composer.text.isNotEmpty() }
            viewModel.send()
            awaitState { it.composer.sending }
            runCurrent()
            val failed = awaitState { it.composer.error != null }

            assertEquals("Keep this draft", failed.composer.text)
            assertEquals(ONLINE_DEVICE.id, failed.composer.targetDeviceId)
            assertFalse(failed.composer.sending)
            cancelAndIgnoreRemainingEvents()
        }
    }

    @Test
    fun sendUsesServerEnvelopeLimitInsteadOfOfflineFallback() = runTest(mainDispatcherRule.dispatcher) {
        val fixture = Fixture().apply { source.envelopeLimit = 150_000L }
        val viewModel = fixture.viewModel()
        val largeDraft = "x".repeat(70_000)

        viewModel.state.test {
            awaitState { !it.loading }
            viewModel.updateComposerText(largeDraft)
            awaitState { it.composer.text.length == largeDraft.length }
            viewModel.send()
            awaitState { it.composer.sending }
            runCurrent()
            val sent = awaitState { !it.composer.sending && it.composer.text.isEmpty() }
            assertNull(sent.composer.error)
            assertEquals(1, fixture.source.created.size)
            cancelAndIgnoreRemainingEvents()
        }
    }

    @Test
    fun undoWithinGracePreventsDeleteRequestAndRestoresRow() = runTest(mainDispatcherRule.dispatcher) {
        val fixture = Fixture(initialPushes = listOf(notePush(PUSH_ONE)))
        val viewModel = fixture.viewModel()

        viewModel.state.test {
            awaitState { !it.loading && it.pushes.size == 1 }
            viewModel.delete(PUSH_ONE)
            val hidden = awaitState { PUSH_ONE in it.hiddenPushIds }
            assertTrue(hidden.visiblePushes.isEmpty())

            advanceTimeBy(HomeViewModel.DELETE_GRACE_MILLIS - 1)
            runCurrent()
            assertTrue(fixture.source.deletedRemote.isEmpty())
            viewModel.undoDelete(PUSH_ONE)
            val restored = awaitState { PUSH_ONE !in it.hiddenPushIds }
            assertEquals(PUSH_ONE, restored.visiblePushes.single().push.id)
            advanceTimeBy(HomeViewModel.DELETE_GRACE_MILLIS)
            runCurrent()
            assertTrue(fixture.source.deletedRemote.isEmpty())
            cancelAndIgnoreRemainingEvents()
        }
    }

    @Test
    fun deleteWaitsFiveSecondsBeforeApiAndRemovesStoredRow() = runTest(mainDispatcherRule.dispatcher) {
        val fixture = Fixture(initialPushes = listOf(notePush(PUSH_ONE)))
        val viewModel = fixture.viewModel()

        viewModel.state.test {
            awaitState { !it.loading && it.pushes.isNotEmpty() }
            viewModel.delete(PUSH_ONE)
            awaitState { it.undoPushId == PUSH_ONE }
            advanceTimeBy(HomeViewModel.DELETE_GRACE_MILLIS - 1)
            runCurrent()
            assertTrue(fixture.source.deletedRemote.isEmpty())
            advanceTimeBy(1)
            runCurrent()
            val deleted = awaitState { it.pushes.isEmpty() }
            assertTrue(deleted.visiblePushes.isEmpty())
            assertEquals(listOf(PUSH_ONE), fixture.source.deletedRemote)
            assertEquals(listOf(PUSH_ONE), fixture.source.deletedStored)
            cancelAndIgnoreRemainingEvents()
        }
    }

    @Test
    fun undoAtGraceBoundaryCannotCancelAnIssuedDelete() = runTest(mainDispatcherRule.dispatcher) {
        val fixture = Fixture(initialPushes = listOf(notePush(PUSH_ONE))).apply {
            source.deleteGate = CompletableDeferred()
        }
        val viewModel = fixture.viewModel()

        viewModel.state.test {
            awaitState { !it.loading && it.pushes.isNotEmpty() }
            viewModel.delete(PUSH_ONE)
            awaitState { it.undoPushId == PUSH_ONE }
            advanceTimeBy(HomeViewModel.DELETE_GRACE_MILLIS)
            runCurrent()
            val issued = awaitState { it.undoPushId == null && PUSH_ONE in it.hiddenPushIds }
            assertTrue(issued.visiblePushes.isEmpty())
            assertEquals(listOf(PUSH_ONE), fixture.source.deletedRemote)

            viewModel.undoDelete(PUSH_ONE)
            assertTrue(viewModel.state.value.hiddenPushIds.contains(PUSH_ONE))
            fixture.source.deleteGate?.complete(Unit)
            runCurrent()
            awaitState { it.pushes.isEmpty() }
            cancelAndIgnoreRemainingEvents()
        }
    }

    @Test
    fun deleteFailureRestoresRowAndReportsRecovery() = runTest(mainDispatcherRule.dispatcher) {
        val fixture = Fixture(initialPushes = listOf(notePush(PUSH_ONE))).apply {
            source.deleteFailure = IOException("offline")
        }
        val viewModel = fixture.viewModel()

        viewModel.state.test {
            awaitState { !it.loading && it.pushes.isNotEmpty() }
            viewModel.delete(PUSH_ONE)
            awaitState { it.hiddenPushIds.isNotEmpty() }
            advanceTimeBy(HomeViewModel.DELETE_GRACE_MILLIS)
            runCurrent()
            val failed = awaitState { it.error?.startsWith("Could not delete") == true }
            assertEquals(PUSH_ONE, failed.visiblePushes.single().push.id)
            assertTrue(fixture.source.deletedStored.isEmpty())
            cancelAndIgnoreRemainingEvents()
        }
    }

    @Test
    fun notFoundDeleteIsSuccessfulAndRemovesStoredRow() = runTest(mainDispatcherRule.dispatcher) {
        val fixture = Fixture(initialPushes = listOf(notePush(PUSH_ONE))).apply {
            source.deleteFailure = ApiError("not_found", 404, "gone")
        }
        val viewModel = fixture.viewModel()

        viewModel.state.test {
            awaitState { !it.loading && it.pushes.isNotEmpty() }
            viewModel.delete(PUSH_ONE)
            awaitState { it.hiddenPushIds.isNotEmpty() }
            advanceTimeBy(HomeViewModel.DELETE_GRACE_MILLIS)
            runCurrent()
            awaitState { it.pushes.isEmpty() }
            assertEquals(listOf(PUSH_ONE), fixture.source.deletedStored)
            cancelAndIgnoreRemainingEvents()
        }
    }

    @Test
    fun refreshSortsTargetListAndDropsRemovedSelection() = runTest(mainDispatcherRule.dispatcher) {
        val fixture = Fixture(devices = listOf(ONLINE_DEVICE, OFFLINE_DEVICE))
        val viewModel = fixture.viewModel()

        viewModel.state.test {
            val loaded = awaitState { !it.loading && it.devices.size == 2 }
            assertEquals(listOf("Alpha laptop", "Zeta phone"), loaded.devices.map(DeviceDTO::name))
            assertTrue(loaded.devices.first().online)
            assertFalse(loaded.devices.last().online)
            fixture.source.emitDevices(
                listOf(ONLINE_DEVICE.copy(online = false), OFFLINE_DEVICE.copy(online = true))
            )
            val liveUpdate = awaitState {
                it.devices.firstOrNull { device -> device.id == OFFLINE_DEVICE.id }?.online == true
            }
            assertFalse(liveUpdate.devices.first { it.id == ONLINE_DEVICE.id }.online)

            viewModel.selectTarget(OFFLINE_DEVICE.id)
            awaitState { it.composer.targetDeviceId == OFFLINE_DEVICE.id }
            fixture.source.remoteDevices = listOf(ONLINE_DEVICE)
            viewModel.retry()
            val refreshed = awaitState { !it.loading && it.devices.size == 1 }
            assertNull(refreshed.composer.targetDeviceId)
            cancelAndIgnoreRemainingEvents()
        }
    }

    @Test
    fun liveDeviceRemovalWinsWhileHistoryRefreshIsStillPending() = runTest(mainDispatcherRule.dispatcher) {
        val fixture = Fixture(devices = listOf(ONLINE_DEVICE, OFFLINE_DEVICE)).apply {
            source.listGate = CompletableDeferred()
        }
        val viewModel = fixture.viewModel()
        viewModel.state.test {
            awaitState { it.devices.size == 2 }
            viewModel.selectTarget(OFFLINE_DEVICE.id)
            awaitState { it.composer.targetDeviceId == OFFLINE_DEVICE.id }
            val renamed = ONLINE_DEVICE.copy(name = "Renamed laptop")
            fixture.source.emitDevices(listOf(renamed))
            awaitState { it.devices.size == 1 && it.composer.targetDeviceId == null }
            fixture.source.listGate?.complete(Unit)
            runCurrent()
            val finished = awaitState { !it.loading }
            assertEquals(listOf(ONLINE_DEVICE.id), finished.devices.map(DeviceDTO::id))
            assertEquals(renamed.name, finished.devices.single().name)
            assertNull(finished.composer.targetDeviceId)
            cancelAndIgnoreRemainingEvents()
        }
    }

    @Test
    fun cachedHistoryStopsBlockingLoadingWhileHttpRefreshIsPending() = runTest(mainDispatcherRule.dispatcher) {
        val fixture = Fixture(initialPushes = listOf(notePush(PUSH_ONE))).apply {
            source.listGate = CompletableDeferred()
        }
        val viewModel = fixture.viewModel()

        viewModel.state.test {
            assertTrue(awaitItem().loading)
            runCurrent()
            val cached = awaitState { !it.loading && it.pushes.size == 1 }
            assertNull(cached.error)
            fixture.source.listGate?.complete(Unit)
            runCurrent()
            cancelAndIgnoreRemainingEvents()
        }
    }

    @Test
    fun loadingFailureKeepsCachedHistoryAndRetryRecovers() = runTest(mainDispatcherRule.dispatcher) {
        val fixture = Fixture(initialPushes = listOf(notePush(PUSH_ONE))).apply {
            source.listFailure = IOException("offline")
        }
        val viewModel = fixture.viewModel()

        viewModel.state.test {
            assertTrue(awaitItem().loading)
            runCurrent()
            val failed = awaitState { !it.loading && it.error != null }
            assertEquals(PUSH_ONE, failed.visiblePushes.single().push.id)

            fixture.source.listFailure = null
            viewModel.retry()
            runCurrent()
            val recovered = awaitState { !it.loading && it.error == null }
            assertEquals(PUSH_ONE, recovered.visiblePushes.single().push.id)
            assertEquals(listOf(null, null), fixture.source.listedBefore)
            cancelAndIgnoreRemainingEvents()
        }
    }

    @Test
    fun historyRefreshPersistsSuccessfulPageWhenDeviceRefreshFails() = runTest(mainDispatcherRule.dispatcher) {
        val fixture = Fixture().apply {
            source.firstPage = ListPushesResponse(listOf(notePush(PUSH_ONE)), null)
            source.devicesFailure = IOException("devices offline")
        }
        val viewModel = fixture.viewModel()

        viewModel.state.test {
            runCurrent()
            val partial = awaitState { !it.loading && it.error != null && it.pushes.size == 1 }
            assertEquals(PUSH_ONE, partial.pushes.single().push.id)
            assertEquals(listOf(null), fixture.source.listedBefore)
            cancelAndIgnoreRemainingEvents()
        }
    }

    @Test
    fun pagingPersistsEncryptedOlderPageNewestFirst() = runTest(mainDispatcherRule.dispatcher) {
        val older = notePush(PUSH_TWO, createdAt = "2026-10-30T08:00:00.000Z")
        val fixture = Fixture(initialPushes = listOf(notePush(PUSH_ONE))).apply {
            source.firstPage = ListPushesResponse(emptyList(), PAGE_CURSOR)
            source.pages[PAGE_CURSOR] = ListPushesResponse(listOf(older), null)
        }
        val viewModel = fixture.viewModel()

        viewModel.state.test {
            awaitState { !it.loading && it.nextBefore == PAGE_CURSOR }
            viewModel.loadOlder()
            awaitState { it.loadingMore }
            runCurrent()
            val paged = awaitState { !it.loadingMore && it.pushes.size == 2 }
            assertEquals(listOf(PUSH_ONE, PUSH_TWO), paged.pushes.map { it.push.id })
            assertEquals(listOf(null, PAGE_CURSOR), fixture.source.listedBefore)
            assertNull(paged.nextBefore)
            cancelAndIgnoreRemainingEvents()
        }
    }

    @Test
    fun missingNotificationPushIsFetchedStoredAndRepeatNavigationRetriggers() = runTest(mainDispatcherRule.dispatcher) {
        val fixture = Fixture().apply {
            source.byId[PUSH_TWO] = notePush(PUSH_TWO)
        }
        val viewModel = fixture.viewModel()

        viewModel.state.test {
            awaitState { !it.loading }
            viewModel.selectPush(PUSH_TWO, navigationId = 7L)
            runCurrent()
            val selected = awaitState {
                it.highlightedPushId == PUSH_TWO && it.pushes.size == 1
            }
            assertEquals(7L, selected.highlightRequestId)
            assertEquals(PUSH_TWO, selected.pushes.single().push.id)
            assertEquals(listOf(PUSH_TWO), fixture.source.requestedIds)

            viewModel.selectPush(PUSH_TWO, navigationId = 8L)
            val repeated = awaitState { it.highlightRequestId == 8L }
            assertEquals(PUSH_TWO, repeated.highlightedPushId)
            assertEquals(listOf(PUSH_TWO), fixture.source.requestedIds)
            cancelAndIgnoreRemainingEvents()
        }
    }

    @Test
    fun deletedPageBoundaryReloadsFirstPageSoOlderHistoryRemainsReachable() = runTest(mainDispatcherRule.dispatcher) {
        val newest = notePush(PUSH_ONE)
        val deletedBoundary = notePush(PUSH_TWO, createdAt = "2026-10-31T08:00:00.000Z")
        val replacementBoundary = notePush(PUSH_THREE, createdAt = "2026-10-31T07:00:00.000Z")
        val fixture = Fixture().apply {
            source.firstPage = ListPushesResponse(listOf(newest, deletedBoundary), PUSH_TWO)
        }
        val viewModel = fixture.viewModel()

        viewModel.state.test {
            awaitState { !it.loading && it.nextBefore == PUSH_TWO && it.pushes.size == 2 }
            fixture.source.firstPage =
                ListPushesResponse(listOf(newest, replacementBoundary), PUSH_THREE)
            fixture.source.removeStored(PUSH_TWO)

            val repaired = awaitState {
                it.nextBefore == PUSH_THREE && it.pushes.any { item -> item.push.id == PUSH_THREE }
            }
            assertEquals(listOf(null, null), fixture.source.listedBefore)
            assertFalse(repaired.pushes.any { item -> item.push.id == PUSH_TWO })
            cancelAndIgnoreRemainingEvents()
        }
    }

    @Test
    fun supersededNotificationLookupCannotReplaceLatestSelection() = runTest(mainDispatcherRule.dispatcher) {
        val fixture = Fixture(initialPushes = listOf(notePush(PUSH_TWO))).apply {
            source.byId[PUSH_ONE] = notePush(PUSH_ONE)
            source.loadPushGates[PUSH_ONE] = CompletableDeferred()
            source.loadPushFailures[PUSH_ONE] = IOException("superseded lookup failed")
        }
        val viewModel = fixture.viewModel()

        viewModel.state.test {
            awaitState { !it.loading && it.pushes.size == 1 }
            viewModel.selectPush(PUSH_ONE, navigationId = 10L)
            runCurrent()
            assertEquals(listOf(PUSH_ONE), fixture.source.requestedIds)

            viewModel.selectPush(PUSH_TWO, navigationId = 11L)
            val latest = awaitState { it.highlightRequestId == 11L }
            assertEquals(PUSH_TWO, latest.highlightedPushId)
            fixture.source.loadPushGates.getValue(PUSH_ONE).complete(Unit)
            runCurrent()

            assertEquals(PUSH_TWO, viewModel.state.value.highlightedPushId)
            assertEquals(11L, viewModel.state.value.highlightRequestId)
            assertNull(viewModel.state.value.error)
            cancelAndIgnoreRemainingEvents()
        }
    }

    @Test
    fun scrollRequestWaitsForTargetAndIsConsumedOncePerNavigationId() {
        val consumer = HomeScrollRequestConsumer()
        val first = decrypted(notePush(PUSH_ONE))
        val target = decrypted(notePush(PUSH_TWO))

        assertNull(consumer.consume(navigationId = 20L, targetPushId = PUSH_TWO, pushes = listOf(first)))
        assertEquals(
            1,
            consumer.consume(navigationId = 20L, targetPushId = PUSH_TWO, pushes = listOf(first, target))
        )
        assertNull(
            consumer.consume(
                navigationId = 20L,
                targetPushId = PUSH_TWO,
                pushes = listOf(target, first)
            )
        )
        assertEquals(
            0,
            consumer.consume(navigationId = 21L, targetPushId = PUSH_TWO, pushes = listOf(target, first))
        )
    }

    private class Fixture(initialPushes: List<PushDTO> = emptyList(), devices: List<DeviceDTO> = emptyList()) {
        val source = FakeHomeDataSource(KEY, initialPushes).apply {
            remoteDevices = devices
        }

        fun viewModel(): HomeViewModel = HomeViewModel(
            source = source,
            contentKey = KEY,
            maxEnvelopeBytes = 65_536L
        )
    }

    private class FakeHomeDataSource(private val key: SecretKey, initialPushes: List<PushDTO>) : HomeDataSource {
        private val mutableHistory =
            MutableStateFlow(initialPushes.map(::decrypt).sortedByDescending { it.push.createdAt })
        private val mutableDevices = MutableStateFlow<List<DeviceDTO>>(emptyList())
        override val history: Flow<List<DecryptedPush>> = mutableHistory
        override val devices: Flow<List<DeviceDTO>> = mutableDevices
        var remoteDevices: List<DeviceDTO> = emptyList()
        var firstPage = ListPushesResponse(emptyList(), null)
        val pages = mutableMapOf<String, ListPushesResponse>()
        val byId = mutableMapOf<String, PushDTO>()
        val created = mutableListOf<CreatePushRequest>()
        val deletedRemote = mutableListOf<String>()
        val deletedStored = mutableListOf<String>()
        val requestedIds = mutableListOf<String>()
        val listedBefore = mutableListOf<String?>()
        var listFailure: Exception? = null
        var createFailure: Exception? = null
        var deleteFailure: Exception? = null
        var devicesFailure: Exception? = null
        var listGate: CompletableDeferred<Unit>? = null
        var deleteGate: CompletableDeferred<Unit>? = null
        val loadPushGates = mutableMapOf<String, CompletableDeferred<Unit>>()
        val loadPushFailures = mutableMapOf<String, Exception>()
        var envelopeLimit: Long = 65_536L

        override suspend fun refreshDevices() {
            devicesFailure?.let { throw it }
            mutableDevices.value = remoteDevices
        }

        override suspend fun maxEnvelopeBytes(): Long = envelopeLimit

        override suspend fun loadPage(before: String?): ListPushesResponse {
            listedBefore += before
            listGate?.await()
            listFailure?.let { throw it }
            val response = if (before == null) firstPage else pages.getValue(before)
            store(response.pushes)
            return response
        }

        override suspend fun loadPush(id: String): PushDTO {
            requestedIds += id
            loadPushGates[id]?.let { gate ->
                kotlinx.coroutines.withContext(kotlinx.coroutines.NonCancellable) { gate.await() }
            }
            loadPushFailures[id]?.let { throw it }
            return byId.getValue(id).also { push -> store(listOf(push)) }
        }

        override suspend fun createPush(request: CreatePushRequest): PushDTO {
            createFailure?.let { throw it }
            created += request
            return PushDTO(
                id = request.id,
                createdAt = "2026-10-31T10:00:00.000Z",
                sourceDeviceId = DEVICE_SELF,
                targetDeviceId = request.targetDeviceId,
                envelope = request.envelope,
                file = null
            ).also { push -> store(listOf(push)) }
        }

        override suspend fun deletePush(id: String) {
            deletedRemote += id
            deleteGate?.await()
            val failure = deleteFailure
            if (failure != null && (failure !is ApiError || failure.status != 404)) throw failure
            deletedStored += id
            mutableHistory.value = mutableHistory.value.filterNot { it.push.id == id }
        }

        fun removeStored(id: String) {
            mutableHistory.value = mutableHistory.value.filterNot { it.push.id == id }
        }

        private fun store(pushes: List<PushDTO>) {
            val merged = (mutableHistory.value + pushes.map(::decrypt))
                .associateBy { item -> item.push.id }
                .values
                .sortedWith(compareByDescending<DecryptedPush> { it.push.createdAt }.thenByDescending { it.push.id })
            mutableHistory.value = merged
        }
        fun emitDevices(devices: List<DeviceDTO>) {
            mutableDevices.value = devices
        }

        private fun decrypt(push: PushDTO) = DecryptedPush(
            push = push,
            payload = PushCrypto.decrypt(key, push.id, push.envelope),
            notified = false
        )
    }

    private suspend fun ReceiveTurbine<HomeUiState>.awaitState(predicate: (HomeUiState) -> Boolean): HomeUiState {
        while (true) {
            val item = awaitItem()
            if (predicate(item)) return item
        }
    }

    companion object {
        private val KEY = SecretKeySpec(ByteArray(32) { index -> index.toByte() }, "AES")
        private const val DEVICE_SELF = "019a3a20-1000-7000-8000-000000000001"
        private const val DEVICE_ONLINE = "019a3a20-1000-7000-8000-000000000002"
        private const val DEVICE_OFFLINE = "019a3a20-1000-7000-8000-000000000003"
        private const val PUSH_ONE = "019a3a20-2000-7000-8000-000000000001"
        private const val PUSH_TWO = "019a3a20-2000-7000-8000-000000000002"
        private const val PUSH_THREE = "019a3a20-2000-7000-8000-000000000003"
        private const val PAGE_CURSOR = "019a3a20-2000-7000-8000-000000000099"

        private val ONLINE_DEVICE = device(DEVICE_ONLINE, "Alpha laptop", online = true)
        private val OFFLINE_DEVICE = device(DEVICE_OFFLINE, "Zeta phone", online = false)

        private fun device(id: String, name: String, online: Boolean) = DeviceDTO(
            id = id,
            name = name,
            platform = Platform.ANDROID,
            createdAt = "2026-10-29T08:00:00.000Z",
            lastSeenAt = "2026-10-31T09:00:00.000Z",
            online = online
        )

        private fun notePush(id: String, createdAt: String = "2026-10-31T09:00:00.000Z"): PushDTO =
            encryptedPush(id, createdAt, NotePayload(body = "Fixture note"))

        private fun decrypted(push: PushDTO) = DecryptedPush(
            push = push,
            payload = PushCrypto.decrypt(KEY, push.id, push.envelope),
            notified = false
        )

        private fun encryptedPush(id: String, createdAt: String, payload: PushPayload): PushDTO = PushDTO(
            id = id,
            createdAt = createdAt,
            sourceDeviceId = DEVICE_SELF,
            targetDeviceId = null,
            envelope = PushCrypto.encrypt(KEY, id, payload),
            file = null
        )
    }
}
