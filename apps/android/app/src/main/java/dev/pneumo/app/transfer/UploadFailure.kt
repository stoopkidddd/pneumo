package dev.pneumo.app.transfer

import androidx.work.ListenableWorker.Result
import androidx.work.workDataOf
import dev.pneumo.app.net.ApiError
import java.io.IOException

internal fun Throwable.isRetryableUploadFailure(): Boolean {
    var current: Throwable? = this
    var decision: Boolean? = null
    var hasIoFailure = false
    while (current != null && decision == null) {
        decision = when (current) {
            is UploadSourceException, is UploadSpoolException -> false
            is ApiError -> current.status == HTTP_RATE_LIMITED || current.status >= HTTP_SERVER_ERROR
            else -> null
        }
        if (current is IOException) hasIoFailure = true
        current = current.cause
    }
    return decision ?: hasIoFailure
}

internal fun Throwable.publicUploadMessage(): String {
    var current: Throwable? = this
    var message: String? = null
    while (current != null && message == null) {
        message = when (current) {
            is UploadSourceException -> "The selected file cannot be read."
            is UploadSpoolException -> "Could not read the upload."
            is UploadLimitException -> current.message
            is ApiError -> "The server rejected the upload."
            is IllegalStateException -> "Your paired session changed. Try again."
            else -> null
        }
        current = current.cause
    }
    return message ?: "Could not upload the file."
}

internal fun IOException.toWorkerResult(): Result =
    if (isRetryableUploadFailure()) Result.retry() else Result.failure(failureData(publicUploadMessage()))

internal fun failureData(message: String) = workDataOf(UploadScheduler.ERROR_MESSAGE to message)

internal class UploadSourceException(cause: Throwable? = null) : IOException(cause)
internal class UploadLimitException(override val message: String) : Exception(message)
internal class UploadSpoolException(cause: Throwable? = null) : Exception(cause)
private const val HTTP_RATE_LIMITED = 429
private const val HTTP_SERVER_ERROR = 500
