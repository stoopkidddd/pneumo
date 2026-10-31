package dev.pneumo.app.net

import dev.pneumo.app.protocol.DeviceDTO
import dev.pneumo.app.protocol.ListDevicesResponse
import dev.pneumo.app.protocol.UpdateDeviceRequest

internal class DeviceApiClient(private val context: ApiContext) : DeviceApi {
    override suspend fun listDevices(): ListDevicesResponse = context.executor.json(
        context.requests.authenticated(context.requests.apiUrl(DEVICES_PATH)).get().build(),
        ListDevicesResponse.serializer(),
        HTTP_OK
    )

    override suspend fun updateDevice(id: String, request: UpdateDeviceRequest): DeviceDTO = context.executor.json(
        context.requests.authenticated(context.requests.apiUrl(DEVICES_PATH, id))
            .patch(context.requests.jsonBody(UpdateDeviceRequest.serializer(), request))
            .build(),
        DeviceDTO.serializer(),
        HTTP_OK
    )

    override suspend fun deleteDevice(id: String) {
        context.executor.empty(
            context.requests.authenticated(context.requests.apiUrl(DEVICES_PATH, id)).delete().build(),
            HTTP_NO_CONTENT
        )
    }

    companion object {
        private const val HTTP_OK = 200
        private const val HTTP_NO_CONTENT = 204
        private const val DEVICES_PATH = "/api/devices"
    }
}
