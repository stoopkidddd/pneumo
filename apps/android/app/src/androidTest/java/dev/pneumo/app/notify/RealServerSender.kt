package dev.pneumo.app.notify

import dev.pneumo.app.crypto.Base64Url
import dev.pneumo.app.crypto.FileCrypto
import dev.pneumo.app.crypto.PushCrypto
import dev.pneumo.app.crypto.Uuidv7
import dev.pneumo.app.crypto.deriveKeys
import dev.pneumo.app.net.ApiClient
import dev.pneumo.app.protocol.CreateFileRequest
import dev.pneumo.app.protocol.CreatePushFile
import dev.pneumo.app.protocol.CreatePushRequest
import dev.pneumo.app.protocol.FilePayload
import dev.pneumo.app.protocol.LinkPayload
import dev.pneumo.app.protocol.NotePayload
import dev.pneumo.app.protocol.PayloadFile
import dev.pneumo.app.protocol.PushPayload
import java.io.ByteArrayInputStream
import javax.crypto.SecretKey
import kotlinx.coroutines.CancellationException
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.RequestBody
import okio.BufferedSink

internal class RealServerSender(origin: String, private val deviceId: String, token: String, encodedMasterKey: String) {
    private val http = OkHttpClient()
    private val api = ApiClient(origin, token, http)
    private val contentKey: SecretKey = senderContentKey(encodedMasterKey)
    private val createdPushIds = mutableListOf<String>()

    suspend fun sendNote(title: String, body: String): String = safely("Encrypted note send failed") {
        send(NotePayload(title = title, body = body), file = null)
    }

    suspend fun sendLink(title: String, url: String): String = safely("Encrypted link send failed") {
        send(LinkPayload(title = title, url = url), file = null)
    }

    suspend fun sendFile(name: String, mime: String, plaintext: ByteArray): String =
        safely("Encrypted file send failed") {
            val reservation = api.createFile(CreateFileRequest(FileCrypto.ciphertextSize(plaintext.size.toLong())))
            val fileKey = FileCrypto.generateFileKey()
            try {
                api.uploadTo(
                    reservation.upload,
                    EncryptedBytesRequestBody(plaintext, fileKey, reservation.fileId)
                )
                val payload = FilePayload(
                    file = PayloadFile(
                        name = name,
                        mime = mime,
                        size = plaintext.size.toLong(),
                        key = Base64Url.encode(fileKey)
                    )
                )
                send(payload, CreatePushFile(reservation.fileId))
            } finally {
                fileKey.fill(0)
            }
        }

    suspend fun cleanUp(): Boolean {
        var succeeded = true
        for (pushId in createdPushIds.asReversed()) {
            try {
                api.deletePush(pushId)
            } catch (_: Exception) {
                succeeded = false
            }
        }
        createdPushIds.clear()
        http.dispatcher.executorService.shutdown()
        http.connectionPool.evictAll()
        return succeeded
    }

    private suspend fun send(payload: PushPayload, file: CreatePushFile?): String {
        val pushId = Uuidv7.generate()
        val created = api.createPush(
            CreatePushRequest(
                id = pushId,
                targetDeviceId = null,
                envelope = PushCrypto.encrypt(contentKey, pushId, payload),
                file = file
            )
        )
        createdPushIds += created.id
        if (created.sourceDeviceId != deviceId) throw SenderContractException()
        return created.id
    }

    private suspend fun <T> safely(message: String, operation: suspend () -> T): T = try {
        operation()
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (_: Exception) {
        throw AssertionError(message)
    }
}

private class EncryptedBytesRequestBody(
    private val plaintext: ByteArray,
    private val fileKey: ByteArray,
    private val fileId: String
) : RequestBody() {
    override fun contentType() = OCTET_STREAM

    override fun contentLength(): Long = FileCrypto.ciphertextSize(plaintext.size.toLong())

    override fun writeTo(sink: BufferedSink) {
        ByteArrayInputStream(plaintext).use { input ->
            FileCrypto.encrypt(input, sink.outputStream(), fileKey, fileId)
        }
    }
}

private fun senderContentKey(encodedMasterKey: String): SecretKey {
    val masterKey = try {
        Base64Url.decode(encodedMasterKey)
    } catch (_: Exception) {
        throw AssertionError("Sender credentials are invalid")
    }
    return try {
        deriveKeys(masterKey).contentKey
    } catch (_: Exception) {
        throw AssertionError("Sender credentials are invalid")
    } finally {
        masterKey.fill(0)
    }
}

private class SenderContractException : Exception()

private val OCTET_STREAM = "application/octet-stream".toMediaType()
