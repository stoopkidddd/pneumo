@file:kotlinx.serialization.UseSerializers(StrictLongSerializer::class)

package dev.pneumo.app.protocol

import kotlinx.serialization.Serializable

private const val PROTOCOL_VERSION = 1L
private const val CREDENTIAL_BYTES = 32
private const val PAIR_CODE_BYTES = 16
private const val KDF_SALT_BYTES = 16
private const val WEB_PUSH_PUBLIC_KEY_BYTES = 65
private const val WEB_PUSH_AUTH_BYTES = 16
private const val NONCE_BYTES = 12
private const val GCM_TAG_BYTES = 16
private const val MIN_PUSH_LIMIT = 1L
private const val MAX_PUSH_LIMIT = 100L
const val DEFAULT_PUSH_LIMIT = 50L

@Serializable
data class KdfParams(val alg: String, val iterations: Long, val salt: String) {
    init {
        require(alg == "PBKDF2-SHA256") { "alg must be PBKDF2-SHA256" }
        requirePositiveInteger(iterations, "iterations")
        requireEncodedBytes(salt, KDF_SALT_BYTES, "salt")
    }
}

@Serializable
data class Envelope(val v: Long, val n: String, val c: String) {
    init {
        require(v == PROTOCOL_VERSION) { "v must be 1" }
        requireEncodedBytes(n, NONCE_BYTES, "n")
        requireCanonicalBase64Url(c, "c")
        require(encodedByteCount(c) >= GCM_TAG_BYTES) { "c must include a GCM tag" }
    }
}

@Serializable
class WebPushKeys(val p256dh: String, val auth: String) {
    init {
        requireEncodedBytes(p256dh, WEB_PUSH_PUBLIC_KEY_BYTES, "p256dh")
        requireEncodedBytes(auth, WEB_PUSH_AUTH_BYTES, "auth")
    }
}

@Serializable
class WebPushSubscription(val endpoint: String, val keys: WebPushKeys) {
    init {
        requireHttpUrl(endpoint, "endpoint")
    }
}

@Serializable
data class DeviceInput(val name: String, val platform: Platform)

@Serializable
data class DeviceRecord(
    val name: String,
    val platform: Platform,
    val v: Long,
    val id: String,
    val createdAt: String,
    val lastSeenAt: String,
    val tokenHash: String,
    val webPush: WebPushSubscription?
) {
    init {
        require(v == PROTOCOL_VERSION) { "v must be 1" }
        requireUuidV7(id, "id")
        requireIsoTimestamp(createdAt, "createdAt")
        requireIsoTimestamp(lastSeenAt, "lastSeenAt")
        requireEncodedBytes(tokenHash, CREDENTIAL_BYTES, "tokenHash")
    }

    override fun toString(): String = "DeviceRecord([redacted])"
}

@Serializable
data class DeviceDTO(
    val name: String,
    val platform: Platform,
    val id: String,
    val createdAt: String,
    val lastSeenAt: String,
    val online: Boolean
) {
    init {
        requireUuidV7(id, "id")
        requireIsoTimestamp(createdAt, "createdAt")
        requireIsoTimestamp(lastSeenAt, "lastSeenAt")
    }
}

@Serializable
data class PushFile(val id: String, val size: Long) {
    init {
        requireUuidV7(id, "file.id")
        requireByteCount(size, "file.size")
    }
}

@Serializable
data class PushRecord(
    val v: Long,
    val id: String,
    val createdAt: String,
    val sourceDeviceId: String,
    val targetDeviceId: String?,
    val envelope: Envelope,
    val file: PushFile?
) {
    init {
        require(v == PROTOCOL_VERSION) { "v must be 1" }
        requireUuidV7(id, "id")
        requireIsoTimestamp(createdAt, "createdAt")
        requireUuidV7(sourceDeviceId, "sourceDeviceId")
        targetDeviceId?.let { requireUuidV7(it, "targetDeviceId") }
    }
}

@Serializable
data class PushDTO(
    val id: String,
    val createdAt: String,
    val sourceDeviceId: String,
    val targetDeviceId: String?,
    val envelope: Envelope,
    val file: PushFile?
) {
    init {
        requireUuidV7(id, "id")
        requireIsoTimestamp(createdAt, "createdAt")
        requireUuidV7(sourceDeviceId, "sourceDeviceId")
        targetDeviceId?.let { requireUuidV7(it, "targetDeviceId") }
    }
}

@Serializable
data class Limits(val maxFileBytes: Long, val maxEnvelopeBytes: Long) {
    init {
        requireByteCount(maxFileBytes, "maxFileBytes")
        requireByteCount(maxEnvelopeBytes, "maxEnvelopeBytes")
    }
}

@Serializable
data class ErrorDetail(val code: ErrorCode, val message: String)

@Serializable
data class ErrorBody(val error: ErrorDetail)

@Serializable
data class HealthResponse(val ok: Boolean, val version: String, val initialized: Boolean) {
    init {
        require(ok) { "ok must be true" }
    }
}

@Serializable
class SetupRequest(
    val setupToken: String,
    val kdf: KdfParams,
    val authKey: String,
    val keyCheck: String,
    val device: DeviceInput
) {
    init {
        require(setupToken.isNotEmpty()) { "setupToken must not be empty" }
        requireEncodedBytes(authKey, CREDENTIAL_BYTES, "authKey")
        requireEncodedBytes(keyCheck, CREDENTIAL_BYTES, "keyCheck")
    }
}

@Serializable
class SetupResponse(val device: DeviceDTO, val token: String) {
    init {
        requireEncodedBytes(token, CREDENTIAL_BYTES, "token")
    }
}

typealias LoginResponse = SetupResponse
typealias ClaimPairResponse = SetupResponse

@Serializable
data class AuthParamsResponse(val kdf: KdfParams)

@Serializable
class LoginRequest(val authKey: String, val device: DeviceInput) {
    init {
        requireEncodedBytes(authKey, CREDENTIAL_BYTES, "authKey")
    }
}

@Serializable
class MeResponse(
    val device: DeviceDTO,
    val keyCheck: String,
    val limits: Limits,
    val vapidPublicKey: String,
    val uploadMode: UploadMode
) {
    init {
        requireEncodedBytes(keyCheck, CREDENTIAL_BYTES, "keyCheck")
        requireEncodedBytes(vapidPublicKey, WEB_PUSH_PUBLIC_KEY_BYTES, "vapidPublicKey")
    }
}

@Serializable
data class ListDevicesResponse(val devices: List<DeviceDTO>)

@Serializable
data class UpdateDeviceRequest(val name: String)

@Serializable
class SubscribeWebPushRequest(val subscription: WebPushSubscription)

@Serializable
class CreatePairResponse(val code: String, val expiresAt: String) {
    init {
        requireEncodedBytes(code, PAIR_CODE_BYTES, "code")
        requireIsoTimestamp(expiresAt, "expiresAt")
    }
}

@Serializable
class ClaimPairRequest(val code: String, val device: DeviceInput) {
    init {
        requireEncodedBytes(code, PAIR_CODE_BYTES, "code")
    }
}

@Serializable
data class CreateFileRequest(val size: Long) {
    init {
        requireByteCount(size, "size")
    }
}

@Serializable
class UploadTarget(val method: String, val url: String, val headers: Map<String, String>) {
    init {
        require(method == "PUT") { "upload method must be PUT" }
        requireTransferUrl(url, "upload.url")
    }
}

@Serializable
class CreateFileResponse(val fileId: String, val upload: UploadTarget, val expiresAt: String) {
    init {
        requireUuidV7(fileId, "fileId")
        requireIsoTimestamp(expiresAt, "expiresAt")
    }
}

@Serializable
class DownloadTarget(val url: String, val headers: Map<String, String>) {
    init {
        requireTransferUrl(url, "download.url")
    }
}

@Serializable
class GetFileResponse(val download: DownloadTarget, val expiresAt: String) {
    init {
        requireIsoTimestamp(expiresAt, "expiresAt")
    }
}

@Serializable
data class CreatePushFile(val id: String) {
    init {
        requireUuidV7(id, "file.id")
    }
}

@Serializable
data class CreatePushRequest(
    val id: String,
    val targetDeviceId: String?,
    val envelope: Envelope,
    val file: CreatePushFile?
) {
    init {
        requireUuidV7(id, "id")
        targetDeviceId?.let { requireUuidV7(it, "targetDeviceId") }
    }
}

@Serializable(with = ListPushesQuerySerializer::class)
data class ListPushesQuery(val before: String? = null, val limit: Long = DEFAULT_PUSH_LIMIT) {
    init {
        before?.let { requireUuidV7(it, "before") }
        require(limit in MIN_PUSH_LIMIT..MAX_PUSH_LIMIT) { "limit must be between 1 and 100" }
    }
}

@Serializable
data class ListPushesResponse(val pushes: List<PushDTO>, val nextBefore: String?) {
    init {
        nextBefore?.let { requireUuidV7(it, "nextBefore") }
    }
}
