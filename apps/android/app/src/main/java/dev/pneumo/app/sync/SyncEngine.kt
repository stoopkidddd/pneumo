package dev.pneumo.app.sync

import dev.pneumo.app.data.SessionCache
import dev.pneumo.app.data.SyncCursorStore
import dev.pneumo.app.data.db.PneumoDatabase
import dev.pneumo.app.data.db.PushEntity
import dev.pneumo.app.data.db.SyncStateEntity
import dev.pneumo.app.data.db.toEntity
import dev.pneumo.app.net.PushApi
import dev.pneumo.app.protocol.DeviceAddedFrame
import dev.pneumo.app.protocol.DeviceRemovedFrame
import dev.pneumo.app.protocol.DeviceUpdatedFrame
import dev.pneumo.app.protocol.PingFrame
import dev.pneumo.app.protocol.PushDTO
import dev.pneumo.app.protocol.PushDeletedFrame
import dev.pneumo.app.protocol.PushFrame
import dev.pneumo.app.protocol.ReadyFrame
import dev.pneumo.app.protocol.ReplayDoneFrame
import dev.pneumo.app.protocol.ResyncFrame
import dev.pneumo.app.protocol.ServerFrame

fun interface PushSink {
    suspend fun accept(push: PushDTO)

    suspend fun cancel(pushId: String) = Unit
}

class SyncEngine(
    database: PneumoDatabase,
    private val pushApi: PushApi,
    private val cursor: SyncCursorStore,
    private val ownDeviceId: String,
    private val sink: PushSink,
    private val cache: SessionCache
) {
    private val generation = cache.generation()
    private val pushes = database.pushes()
    private val devices = database.devices()
    private val syncState = database.syncState()

    suspend fun apply(frame: ServerFrame) {
        when (frame) {
            is DeviceAddedFrame, is DeviceUpdatedFrame, is DeviceRemovedFrame ->
                cache.withDevices(generation) { applyFrame(frame) }

            is PushFrame, is PushDeletedFrame, is ResyncFrame, is ReadyFrame ->
                cache.withPushes(generation) { applyFrame(frame) }

            is ReplayDoneFrame, is PingFrame -> Unit
        }
    }

    private suspend fun applyFrame(frame: ServerFrame) {
        when (frame) {
            is PushFrame -> applyPush(frame.push)

            is PushDeletedFrame -> {
                pushes.delete(frame.id)
                sink.cancel(frame.id)
            }

            is DeviceAddedFrame -> devices.upsert(frame.device.toEntity())

            is DeviceUpdatedFrame -> devices.upsert(frame.device.toEntity())

            is DeviceRemovedFrame -> devices.delete(frame.id)

            is ResyncFrame -> resync()

            // Catch up before queued live pushes can move the lower bound past an offline gap.
            is ReadyFrame -> if (cursor.read() == null) resync()

            is ReplayDoneFrame,
            is PingFrame -> Unit
        }
    }

    /*
     * Claim before invoking the external sink so replay and restart cannot duplicate it.
     * SQLite and the Android notification service cannot share a transaction: process
     * death after this claim but before the side effect can therefore lose a notification.
     */
    private suspend fun applyPush(push: PushDTO) {
        pushes.insert(push.toEntity())
        if (push.isEligible() && pushes.claimNotification(push.id) == CLAIMED) {
            sink.accept(push)
        }
        advanceCursor(push)
    }

    private suspend fun resync() {
        val lowerBound = currentPosition()
        val pending = mutableListOf<PushDTO>()
        var before: String? = null
        var continuePaging: Boolean
        do {
            val page = pushApi.listPushes(before = before, limit = RESYNC_PAGE_SIZE)
            var overlapped = false
            // History browsing may cache unapplied rows ahead of the durable sync position.
            val existing = if (lowerBound == null) {
                pushes.existingIds(page.pushes.map(PushDTO::id)).toHashSet()
            } else {
                emptySet()
            }
            for (push in page.pushes) {
                if (push.id in existing || (lowerBound != null && !push.isAfter(lowerBound))) {
                    overlapped = true
                    break
                }
                pending += push
            }

            val nextBefore = page.nextBefore
            continuePaging = page.pushes.isNotEmpty() && !overlapped && nextBefore != null
            if (continuePaging) {
                check(nextBefore != before) { "Push pagination did not advance" }
                before = requireNotNull(nextBefore)
            }
        } while (continuePaging)

        pending.sortWith(PUSH_ORDER)
        for (push in pending) {
            applyPush(push)
        }
    }

    /*
     * DataStore is the wire cursor; Room keeps the server ordering tuple because
     * sender-generated UUIDs are not chronological. Write DataStore first. If the
     * process dies before the Room write, currentPosition reconciles both stores.
     */
    private suspend fun advanceCursor(push: PushDTO) {
        val current = currentPosition()
        if (current == null || push.isAfter(current)) {
            cursor.advance(push.id)
            syncState.put(
                SyncStateEntity(
                    lastPushId = push.id,
                    lastCreatedAt = push.createdAt
                )
            )
        }
    }

    private suspend fun currentPosition(): SyncStateEntity? {
        val state = syncState.read()
        val cursorId = cursor.read()
        val cursorPush = if (cursorId == null || cursorId == state?.lastPushId) {
            null
        } else {
            pushes.find(cursorId)
        }
        val current = when {
            cursorPush == null -> state

            state == null || cursorPush.isAfter(state) -> SyncStateEntity(
                lastPushId = cursorPush.id,
                lastCreatedAt = cursorPush.createdAt
            )

            else -> state
        }
        if (current != null && current != state) {
            syncState.put(current)
        }
        return current
    }

    private fun PushEntity.isAfter(position: SyncStateEntity): Boolean = createdAt > position.lastCreatedAt ||
        (createdAt == position.lastCreatedAt && id > position.lastPushId)

    private fun PushDTO.isAfter(position: SyncStateEntity): Boolean = createdAt > position.lastCreatedAt ||
        (createdAt == position.lastCreatedAt && id > position.lastPushId)

    private fun PushDTO.isEligible(): Boolean =
        sourceDeviceId != ownDeviceId && (targetDeviceId == null || targetDeviceId == ownDeviceId)

    private companion object {
        val PUSH_ORDER: Comparator<PushDTO> =
            compareBy<PushDTO> { it.createdAt }.thenBy { it.id }
        const val RESYNC_PAGE_SIZE = 100L
        const val CLAIMED = 1
    }
}
