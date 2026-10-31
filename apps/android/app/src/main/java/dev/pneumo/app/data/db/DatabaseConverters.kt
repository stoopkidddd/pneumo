package dev.pneumo.app.data.db

import androidx.room.TypeConverter
import dev.pneumo.app.protocol.DeviceDTO
import dev.pneumo.app.protocol.Envelope
import dev.pneumo.app.protocol.Platform
import dev.pneumo.app.protocol.ProtocolJson
import dev.pneumo.app.protocol.PushDTO
import dev.pneumo.app.protocol.PushFile

class DatabaseConverters {
    @TypeConverter
    fun platformToWire(platform: Platform): String = when (platform) {
        Platform.WEB -> "web"
        Platform.ANDROID -> "android"
        Platform.DESKTOP -> "desktop"
        Platform.CLI -> "cli"
    }

    @TypeConverter
    fun wireToPlatform(value: String): Platform = when (value) {
        "web" -> Platform.WEB
        "android" -> Platform.ANDROID
        "desktop" -> Platform.DESKTOP
        "cli" -> Platform.CLI
        else -> error("Unknown platform: $value")
    }
}

internal fun PushDTO.toEntity(): PushEntity = PushEntity(
    id = id,
    createdAt = createdAt,
    sourceDeviceId = sourceDeviceId,
    targetDeviceId = targetDeviceId,
    envelopeJson = ProtocolJson.encodeToString(Envelope.serializer(), envelope),
    fileId = file?.id,
    fileSize = file?.size,
    notified = false
)

internal fun PushEntity.toDto(): PushDTO = PushDTO(
    id = id,
    createdAt = createdAt,
    sourceDeviceId = sourceDeviceId,
    targetDeviceId = targetDeviceId,
    envelope = ProtocolJson.decodeFromString(Envelope.serializer(), envelopeJson),
    file = fileId?.let { PushFile(id = it, size = requireNotNull(fileSize)) }
)

internal fun DeviceDTO.toEntity(): DeviceEntity = DeviceEntity(
    id = id,
    name = name,
    platform = platform,
    createdAt = createdAt,
    lastSeenAt = lastSeenAt,
    online = online
)
