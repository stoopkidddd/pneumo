package dev.pneumo.app.crypto

import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

object Hkdf {
    fun derive(
        inputKeyMaterial: ByteArray,
        salt: ByteArray = byteArrayOf(),
        info: ByteArray = byteArrayOf(),
        length: Int
    ): ByteArray {
        require(length >= 0) { "HKDF output length must not be negative" }
        require(length <= HASH_SIZE_BYTES * MAX_BLOCK_COUNT) { "HKDF output is too long" }
        if (length == 0) return byteArrayOf()

        val effectiveSalt = if (salt.isEmpty()) ByteArray(HASH_SIZE_BYTES) else salt
        val extract = Mac.getInstance(HMAC_ALGORITHM)
        extract.init(SecretKeySpec(effectiveSalt, HMAC_ALGORITHM))
        val pseudoRandomKey = extract.doFinal(inputKeyMaterial)
        return try {
            expand(pseudoRandomKey, info, length)
        } finally {
            pseudoRandomKey.fill(0)
        }
    }

    fun derive(inputKeyMaterial: ByteArray, label: String, length: Int = HASH_SIZE_BYTES): ByteArray = derive(
        inputKeyMaterial = inputKeyMaterial,
        info = label.toByteArray(Charsets.UTF_8),
        length = length
    )

    private fun expand(pseudoRandomKey: ByteArray, info: ByteArray, length: Int): ByteArray {
        val result = ByteArray(length)
        val mac = Mac.getInstance(HMAC_ALGORITHM)
        mac.init(SecretKeySpec(pseudoRandomKey, HMAC_ALGORITHM))
        var previous = byteArrayOf()
        var resultOffset = 0
        var counter = 1
        while (resultOffset < length) {
            mac.update(previous)
            mac.update(info)
            mac.update(counter.toByte())
            val next = mac.doFinal()
            previous.fill(0)
            previous = next
            val count = minOf(previous.size, length - resultOffset)
            previous.copyInto(result, destinationOffset = resultOffset, endIndex = count)
            resultOffset += count
            counter += 1
        }
        previous.fill(0)
        return result
    }

    private const val HMAC_ALGORITHM = "HmacSHA256"
    internal const val HASH_SIZE_BYTES = 32
    private const val MAX_BLOCK_COUNT = 255
}
