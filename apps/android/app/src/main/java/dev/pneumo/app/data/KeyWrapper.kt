package dev.pneumo.app.data

/** Authenticated wrapping; callers own and clear plaintext buffers. */
interface KeyWrapper {
    fun wrap(plaintext: ByteArray): ByteArray

    fun unwrap(wrapped: ByteArray): ByteArray
}
