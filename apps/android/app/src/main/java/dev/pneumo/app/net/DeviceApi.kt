package dev.pneumo.app.net

import dev.pneumo.app.protocol.DeviceDTO
import dev.pneumo.app.protocol.ListDevicesResponse
import dev.pneumo.app.protocol.UpdateDeviceRequest

interface DeviceApi {
    suspend fun listDevices(): ListDevicesResponse

    suspend fun updateDevice(id: String, request: UpdateDeviceRequest): DeviceDTO

    suspend fun deleteDevice(id: String)
}
