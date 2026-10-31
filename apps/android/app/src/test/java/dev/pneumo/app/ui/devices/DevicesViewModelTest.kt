package dev.pneumo.app.ui.devices

import app.cash.turbine.test
import dev.pneumo.app.protocol.Platform
import dev.pneumo.app.ui.MainDispatcherRule
import java.io.IOException
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class DevicesViewModelTest {
    @get:Rule
    val mainDispatcherRule = MainDispatcherRule()

    @Test
    fun renameUpdatesAnyDeviceAndClearsInlineEditor() = runTest(mainDispatcherRule.dispatcher) {
        val repository = FakeDeviceRepository()
        val viewModel = DevicesViewModel(repository, OWN_ID)

        viewModel.state.test {
            awaitItem()
            runCurrent()
            assertEquals(listOf(OWN_ID, OTHER_ID), expectMostRecentItem().devices.map { it.id })

            viewModel.beginRename(OWN_ID)
            assertEquals(OWN_ID, awaitItem().editingDeviceId)
            viewModel.updateRenameDraft("  Renamed phone  ")
            assertEquals("  Renamed phone  ", awaitItem().renameDraft)
            viewModel.saveRename()
            runCurrent()

            val renamed = expectMostRecentItem()
            assertEquals("Renamed phone", renamed.devices.first().name)
            assertNull(renamed.editingDeviceId)
            assertEquals(listOf(OWN_ID to "Renamed phone"), repository.renameCalls)
        }
    }

    @Test
    fun removeOtherDeviceRequiresConfirmation() = runTest(mainDispatcherRule.dispatcher) {
        val repository = FakeDeviceRepository()
        val viewModel = DevicesViewModel(repository, OWN_ID)

        viewModel.state.test {
            awaitItem()
            runCurrent()
            expectMostRecentItem()

            viewModel.requestRemove(OTHER_ID)
            assertEquals(OTHER_ID, awaitItem().confirmingRemovalId)
            viewModel.confirmRemove()
            runCurrent()

            val removed = expectMostRecentItem()
            assertEquals(listOf(OWN_ID), removed.devices.map { it.id })
            assertNull(removed.confirmingRemovalId)
            assertEquals(listOf(OTHER_ID), repository.removeCalls)
        }
    }

    @Test
    fun removingOwnDeviceOpensSettingsWithoutCallingRepository() = runTest(mainDispatcherRule.dispatcher) {
        val repository = FakeDeviceRepository()
        val viewModel = DevicesViewModel(repository, OWN_ID)
        runCurrent()

        viewModel.effects.test {
            viewModel.requestRemove(OWN_ID)
            assertEquals(DevicesEffect.OpenSettings, awaitItem())
            assertNull(viewModel.state.value.confirmingRemovalId)
            assertEquals(emptyList<String>(), repository.removeCalls)
        }
    }

    @Test
    fun renameFailureKeepsEditorAndShowsRecoverableError() = runTest(mainDispatcherRule.dispatcher) {
        val repository = FakeDeviceRepository().apply { renameFailure = IOException("offline") }
        val viewModel = DevicesViewModel(repository, OWN_ID)
        runCurrent()

        viewModel.state.test {
            awaitItem()
            viewModel.beginRename(OTHER_ID)
            assertEquals(OTHER_ID, awaitItem().editingDeviceId)
            viewModel.updateRenameDraft("Work browser")
            assertEquals("Work browser", awaitItem().renameDraft)
            viewModel.saveRename()
            runCurrent()

            val failed = expectMostRecentItem()
            assertEquals(OTHER_ID, failed.editingDeviceId)
            assertEquals("Could not rename this device. Check your connection and try again.", failed.error)
            assertNull(failed.busyDeviceId)
        }
    }

    @Test
    fun removeFailureKeepsConfirmationAndShowsRecoverableError() = runTest(mainDispatcherRule.dispatcher) {
        val repository = FakeDeviceRepository().apply { removeFailure = IOException("offline") }
        val viewModel = DevicesViewModel(repository, OWN_ID)
        runCurrent()

        viewModel.state.test {
            awaitItem()
            viewModel.requestRemove(OTHER_ID)
            assertEquals(OTHER_ID, awaitItem().confirmingRemovalId)
            viewModel.confirmRemove()
            runCurrent()

            val failed = expectMostRecentItem()
            assertEquals(OTHER_ID, failed.confirmingRemovalId)
            assertEquals("Could not remove this device. Check your connection and try again.", failed.error)
            assertNull(failed.busyDeviceId)
        }
    }

    @Test
    fun refreshFailureShowsRetryErrorWithoutDiscardingCache() = runTest(mainDispatcherRule.dispatcher) {
        val repository = FakeDeviceRepository().apply { refreshFailure = IOException("offline") }
        val viewModel = DevicesViewModel(repository, OWN_ID)

        viewModel.state.test {
            awaitItem()
            runCurrent()
            val failed = expectMostRecentItem()
            assertEquals(2, failed.devices.size)
            assertEquals("Could not load devices. Check your connection and try again.", failed.error)
            assertEquals(false, failed.loading)
        }
    }

    private class FakeDeviceRepository : DeviceRepository {
        private val devices = MutableStateFlow(listOf(ownDevice(), otherDevice()))
        val renameCalls = mutableListOf<Pair<String, String>>()
        val removeCalls = mutableListOf<String>()
        var refreshFailure: Throwable? = null
        var renameFailure: Throwable? = null
        var removeFailure: Throwable? = null

        override fun observeDevices(): Flow<List<DeviceItem>> = devices

        override suspend fun refresh() {
            refreshFailure?.let { throw it }
        }

        override suspend fun rename(id: String, name: String) {
            renameFailure?.let { throw it }
            renameCalls += id to name
            devices.value = devices.value.map { if (it.id == id) it.copy(name = name) else it }
        }

        override suspend fun remove(id: String) {
            removeFailure?.let { throw it }
            removeCalls += id
            devices.value = devices.value.filterNot { it.id == id }
        }
    }

    companion object {
        private const val OWN_ID = "019a3ce4-3a80-7000-8000-000000000001"
        private const val OTHER_ID = "019a3ce4-3a80-7000-8000-000000000002"

        private fun ownDevice() = DeviceItem(
            id = OWN_ID,
            name = "Pixel 9",
            platform = Platform.ANDROID,
            createdAt = "2026-10-30T10:00:00.000Z",
            lastSeenAt = "2026-10-31T11:59:00.000Z",
            online = true
        )

        private fun otherDevice() = DeviceItem(
            id = OTHER_ID,
            name = "Firefox",
            platform = Platform.WEB,
            createdAt = "2026-10-30T11:00:00.000Z",
            lastSeenAt = "2026-10-31T10:00:00.000Z",
            online = false
        )
    }
}
