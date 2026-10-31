package dev.pneumo.app.net

import java.io.IOException

open class ApiError(val code: String, val status: Int, message: String) : IOException(message) {
    class Unauthorized(message: String = DEFAULT_MESSAGE) :
        ApiError(code = CODE, status = HTTP_UNAUTHORIZED, message = message)

    companion object {
        const val HTTP_UNAUTHORIZED = 401
        const val CODE = "unauthorized"
        const val DEFAULT_MESSAGE = "Unauthorized"
    }
}
