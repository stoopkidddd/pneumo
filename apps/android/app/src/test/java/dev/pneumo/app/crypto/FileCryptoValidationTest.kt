package dev.pneumo.app.crypto

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class FileCryptoValidationTest {
    @Test
    fun wrongVersionAndEveryReservedHeaderByteAreRejected() {
        val file = CryptoVectorFixture.file()
        val fileKey = decodeBytes(file.string("key"))
        val fileId = file.string("fileId")
        val ciphertext = encrypt(byteArrayOf(), fileKey, fileId)

        for (index in VERSION_OFFSET..LAST_RESERVED_OFFSET) {
            val corrupted = ciphertext.copyOf()
            corrupted[index] = (corrupted[index].toInt() xor HEADER_MUTATION).toByte()
            assertRejects(corrupted, fileKey, fileId)
        }
    }

    @Test
    fun finalBlockShorterThanTagIsRejected() {
        val file = CryptoVectorFixture.file()
        val ciphertext = header + ByteArray(TAG_SIZE_BYTES - 1)

        assertRejects(ciphertext, decodeBytes(file.string("key")), file.string("fileId"))
    }

    @Test
    fun authenticatedEmptyLastChunkAfterAnotherChunkIsRejected() {
        val file = CryptoVectorFixture.file()
        val fileKey = decodeBytes(file.string("key"))
        val fileId = file.string("fileId")
        val first = rawEncrypt(fileKey, fileId, 0L, last = false, patternedBytes(CHUNK_SIZE_BYTES))
        val emptyLast = rawEncrypt(fileKey, fileId, 1L, last = true, byteArrayOf())
        val ciphertext = header + first + emptyLast

        assertRejects(ciphertext, fileKey, fileId)
    }

    @Test
    fun ciphertextSizeCoversChunkBoundariesAndOverflow() {
        assertEquals(HEADER_SIZE_BYTES + TAG_SIZE_BYTES, FileCrypto.ciphertextSize(0))
        assertEquals(HEADER_SIZE_BYTES + TAG_SIZE_BYTES + 1L, FileCrypto.ciphertextSize(1))
        assertEquals(
            HEADER_SIZE_BYTES + TAG_SIZE_BYTES + CHUNK_SIZE_BYTES.toLong(),
            FileCrypto.ciphertextSize(CHUNK_SIZE_BYTES.toLong())
        )
        assertEquals(
            HEADER_SIZE_BYTES + TAG_SIZE_BYTES * 2L + CHUNK_SIZE_BYTES + 1L,
            FileCrypto.ciphertextSize(CHUNK_SIZE_BYTES + 1L)
        )
        assertThrows(IllegalArgumentException::class.java) { FileCrypto.ciphertextSize(-1) }
        assertThrows(ArithmeticException::class.java) { FileCrypto.ciphertextSize(Long.MAX_VALUE) }
    }

    private fun encrypt(plaintext: ByteArray, fileKey: ByteArray, fileId: String): ByteArray {
        val output = ByteArrayOutputStream()
        FileCrypto.encrypt(ByteArrayInputStream(plaintext), output, fileKey, fileId)
        return output.toByteArray()
    }

    private fun assertRejects(ciphertext: ByteArray, fileKey: ByteArray, fileId: String) {
        assertThrows(Exception::class.java) {
            FileCrypto.decrypt(
                ByteArrayInputStream(ciphertext),
                ByteArrayOutputStream(),
                fileKey,
                fileId
            )
        }
    }

    private fun rawEncrypt(
        fileKey: ByteArray,
        fileId: String,
        index: Long,
        last: Boolean,
        plaintext: ByteArray
    ): ByteArray {
        val nonce = ByteArray(NONCE_SIZE_BYTES)
        var remaining = index
        for (position in NONCE_COUNTER_END downTo NONCE_COUNTER_START) {
            nonce[position] = remaining.toByte()
            remaining = remaining ushr BITS_PER_BYTE
        }
        nonce[LAST_FLAG_OFFSET] = if (last) 1 else 0
        val cipher = Cipher.getInstance(CIPHER_ALGORITHM)
        cipher.init(
            Cipher.ENCRYPT_MODE,
            SecretKeySpec(fileKey, AES_ALGORITHM),
            GCMParameterSpec(TAG_SIZE_BITS, nonce)
        )
        cipher.updateAAD((FILE_AAD_PREFIX + fileId).toByteArray(Charsets.UTF_8))
        return cipher.doFinal(plaintext)
    }

    private fun patternedBytes(size: Int): ByteArray =
        ByteArray(size) { index -> ((index * PATTERN_MULTIPLIER + PATTERN_ADDEND) and BYTE_MASK).toByte() }

    private companion object {
        val header =
            byteArrayOf(
                'P'.code.toByte(),
                'N'.code.toByte(),
                'M'.code.toByte(),
                'F'.code.toByte(),
                1,
                0,
                0,
                0
            )
        const val AES_ALGORITHM = "AES"
        const val CIPHER_ALGORITHM = "AES/GCM/NoPadding"
        const val FILE_AAD_PREFIX = "pneumo/v1/file:"
        const val CHUNK_SIZE_BYTES = 65_536
        const val TAG_SIZE_BYTES = 16
        const val HEADER_SIZE_BYTES = 8L
        const val VERSION_OFFSET = 4
        const val LAST_RESERVED_OFFSET = 7
        const val HEADER_MUTATION = 1
        const val NONCE_SIZE_BYTES = 12
        const val NONCE_COUNTER_START = 3
        const val NONCE_COUNTER_END = 10
        const val LAST_FLAG_OFFSET = 11
        const val BITS_PER_BYTE = 8
        const val TAG_SIZE_BITS = 128
        const val PATTERN_MULTIPLIER = 31
        const val PATTERN_ADDEND = 17
        const val BYTE_MASK = 255
    }
}
