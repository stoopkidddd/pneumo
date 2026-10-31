package dev.pneumo.app.ui.home

import android.content.Context
import android.net.Uri
import dev.pneumo.app.data.AppSession
import dev.pneumo.app.data.db.PneumoDatabase
import dev.pneumo.app.data.db.toEntity
import dev.pneumo.app.net.ApiError
import dev.pneumo.app.protocol.CreatePushRequest
import dev.pneumo.app.protocol.DeviceDTO
import dev.pneumo.app.protocol.ListPushesResponse
import dev.pneumo.app.protocol.PushDTO
import dev.pneumo.app.sync.DecryptedPush
import dev.pneumo.app.transfer.UploadAttachment
import dev.pneumo.app.transfer.UploadAttachments
import dev.pneumo.app.transfer.UploadOptions
import dev.pneumo.app.transfer.UploadScheduler
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.map

internal interface HomeDataSource {
    val history: Flow<List<DecryptedPush>>
    val devices: Flow<List<DeviceDTO>>

    suspend fun refreshDevices()
    suspend fun maxEnvelopeBytes(): Long

    suspend fun loadPage(before: String?): ListPushesResponse

    suspend fun loadPush(id: String): PushDTO

    suspend fun createPush(request: CreatePushRequest): PushDTO

    suspend fun prepareUploads(uris: List<Uri>): List<UploadAttachment>

    fun discardUploads(attachments: List<UploadAttachment>)

    suspend fun enqueueFiles(attachments: List<UploadAttachment>, targetDeviceId: String?, body: String)

    suspend fun deletePush(id: String)
}

internal class RoomHomeDataSource(
    private val session: AppSession,
    private val database: PneumoDatabase,
    private val context: Context
) : HomeDataSource {
    override val history: Flow<List<DecryptedPush>> = session.pushes.observeAll().flowOn(Dispatchers.Default)
    override val devices: Flow<List<DeviceDTO>> = database.invalidationTracker
        .createFlow("devices", emitInitialState = true)
        .map { cachedDevices() }

    private suspend fun cachedDevices(): List<DeviceDTO> = database.devices().list().map { device ->
        DeviceDTO(
            id = device.id,
            name = device.name,
            platform = device.platform,
            createdAt = device.createdAt,
            lastSeenAt = device.lastSeenAt,
            online = device.online
        )
    }

    override suspend fun refreshDevices() {
        session.cache.withDevices(session.generation) {
            val devices = session.api.listDevices().devices
            val currentIds = devices.mapTo(mutableSetOf(), DeviceDTO::id)
            database.devices().list()
                .filterNot { device -> device.id in currentIds }
                .forEach { device -> database.devices().delete(device.id) }
            devices.forEach { device -> database.devices().upsert(device.toEntity()) }
        }
    }

    override suspend fun maxEnvelopeBytes(): Long = session.api.me().limits.maxEnvelopeBytes

    override suspend fun loadPage(before: String?): ListPushesResponse = session.cache.withPushes(session.generation) {
        session.api.listPushes(before = before).also { response ->
            response.pushes.forEach { push -> database.pushes().insert(push.toEntity()) }
        }
    }

    override suspend fun loadPush(id: String): PushDTO = session.cache.withPushes(session.generation) {
        session.api.getPush(id).also { push ->
            database.pushes().insert(push.toEntity())
        }
    }

    override suspend fun createPush(request: CreatePushRequest): PushDTO {
        val generation = session.generation
        val created = session.api.createPush(request)
        return session.cache.withPushes(generation) {
            database.pushes().insert(created.toEntity())
            created
        }
    }

    override suspend fun prepareUploads(uris: List<Uri>): List<UploadAttachment> =
        UploadAttachments.prepare(context, uris)

    override fun discardUploads(attachments: List<UploadAttachment>) = UploadAttachments.discard(context, attachments)

    override suspend fun enqueueFiles(attachments: List<UploadAttachment>, targetDeviceId: String?, body: String) {
        val limits = try {
            session.api.me().limits
        } catch (cancelled: kotlinx.coroutines.CancellationException) {
            throw cancelled
        } catch (_: java.io.IOException) {
            null
        }
        UploadScheduler.enqueue(
            context = context,
            session = session,
            attachments = attachments,
            options = UploadOptions(
                targetDeviceId = targetDeviceId,
                body = body,
                maxFileBytes = limits?.maxFileBytes ?: DEFAULT_MAX_FILE_BYTES,
                maxEnvelopeBytes = limits?.maxEnvelopeBytes ?: session.maxEnvelopeBytes
            )
        )
    }

    override suspend fun deletePush(id: String) {
        session.cache.withPushes(session.generation) {
            try {
                session.api.deletePush(id)
            } catch (failure: ApiError) {
                if (failure.status != HTTP_NOT_FOUND) throw failure
            }
            database.pushes().delete(id)
        }
    }

    private companion object {
        const val HTTP_NOT_FOUND = 404
        const val DEFAULT_MAX_FILE_BYTES = 524_288_000L
    }
}
