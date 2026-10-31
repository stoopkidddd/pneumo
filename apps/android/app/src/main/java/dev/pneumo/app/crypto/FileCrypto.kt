package dev.pneumo.app.crypto

import java.io.EOFException
import java.io.InputStream
import java.io.OutputStream
import java.lang.Math.addExact
import java.lang.Math.multiplyExact
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

object FileCrypto {
    fun generateFileKey(): ByteArray = ByteArray(KEY_SIZE_BYTES).also(secureRandom::nextBytes)

    fun ciphertextSize(plaintextSize: Long): Long {
        require(plaintextSize >= 0) { "Plaintext size must not be negative" }
        val chunks = maxOf(
            1L,
            plaintextSize / CHUNK_SIZE_BYTES + if (plaintextSize % CHUNK_SIZE_BYTES == 0L) 0L else 1L
        )
        return addExact(
            addExact(header.size.toLong(), plaintextSize),
            multiplyExact(TAG_SIZE_BYTES.toLong(), chunks)
        )
    }

    fun encrypt(input: InputStream, output: OutputStream, fileKey: ByteArray, fileId: String) {
        require(fileKey.size == KEY_SIZE_BYTES) { "Expected a 32-byte file key" }
        output.write(header)
        transformBlocks(
            input = input,
            output = output,
            fileKey = fileKey,
            fileId = fileId,
            decrypt = false
        )
    }

    fun decrypt(input: InputStream, output: OutputStream, fileKey: ByteArray, fileId: String) {
        require(fileKey.size == KEY_SIZE_BYTES) { "Expected a 32-byte file key" }
        readAndValidateHeader(input)
        transformBlocks(
            input = input,
            output = output,
            fileKey = fileKey,
            fileId = fileId,
            decrypt = true
        )
    }

    private fun transformBlocks(
        input: InputStream,
        output: OutputStream,
        fileKey: ByteArray,
        fileId: String,
        decrypt: Boolean
    ) {
        val inputBlockSize = if (decrypt) CIPHERTEXT_BLOCK_SIZE_BYTES else CHUNK_SIZE_BYTES
        val inputBlock = ByteArray(inputBlockSize)
        val outputBlock = ByteArray(CIPHERTEXT_BLOCK_SIZE_BYTES)
        val key: SecretKey = SecretKeySpec(fileKey, AES_ALGORITHM)
        val aad = (FILE_AAD_PREFIX + fileId).toByteArray(Charsets.UTF_8)
        val nonce = ByteArray(NONCE_SIZE_BYTES)
        val cipher = Cipher.getInstance(CIPHER_ALGORITHM)
        var carry = NO_BYTE
        var chunkIndex = 0L
        try {
            while (true) {
                val count = readBlock(input, inputBlock, carry)
                carry = NO_BYTE
                val next = if (count == inputBlock.size) input.read() else NO_BYTE
                val last = next == NO_BYTE
                if (decrypt) validateCiphertextBlock(count, chunkIndex)
                fillNonce(nonce, chunkIndex, last)
                initializeCipher(
                    cipher = cipher,
                    mode = if (decrypt) Cipher.DECRYPT_MODE else Cipher.ENCRYPT_MODE,
                    key = key,
                    nonce = nonce,
                    aad = aad
                )
                val written = cipher.doFinal(inputBlock, 0, count, outputBlock, 0)
                output.write(outputBlock, 0, written)
                if (last) return
                carry = next
                check(chunkIndex != Long.MAX_VALUE) { "File chunk counter overflow" }
                chunkIndex += 1
            }
        } finally {
            inputBlock.fill(0)
            outputBlock.fill(0)
            nonce.fill(0)
        }
    }

    private fun readBlock(input: InputStream, block: ByteArray, initialByte: Int): Int {
        var count = 0
        var exhausted = false
        if (initialByte != NO_BYTE) {
            block[count] = initialByte.toByte()
            count += 1
        }
        while (count < block.size && !exhausted) {
            val read = input.read(block, count, block.size - count)
            when {
                read < 0 -> exhausted = true

                read == 0 -> {
                    val singleByte = input.read()
                    if (singleByte == NO_BYTE) {
                        exhausted = true
                    } else {
                        block[count] = singleByte.toByte()
                        count += 1
                    }
                }

                else -> count += read
            }
        }
        return count
    }

    private fun readAndValidateHeader(input: InputStream) {
        val actual = ByteArray(header.size)
        val count = readBlock(input, actual, NO_BYTE)
        if (count != header.size) throw EOFException("Missing file header")
        require(actual.contentEquals(header)) { "Invalid file header" }
    }

    private fun validateCiphertextBlock(count: Int, chunkIndex: Long) {
        require(count >= TAG_SIZE_BYTES) { "Invalid final file block" }
        require(count != TAG_SIZE_BYTES || chunkIndex == 0L) { "Invalid empty final file block" }
    }

    private fun initializeCipher(cipher: Cipher, mode: Int, key: SecretKey, nonce: ByteArray, aad: ByteArray) {
        cipher.init(mode, key, GCMParameterSpec(TAG_SIZE_BITS, nonce))
        cipher.updateAAD(aad)
    }

    private fun fillNonce(nonce: ByteArray, index: Long, last: Boolean) {
        require(index >= 0) { "File chunk counter overflow" }
        nonce.fill(0)
        var remaining = index
        for (position in NONCE_COUNTER_END downTo NONCE_COUNTER_START) {
            nonce[position] = remaining.toByte()
            remaining = remaining ushr BITS_PER_BYTE
        }
        nonce[LAST_FLAG_OFFSET] = if (last) LAST_FLAG else NOT_LAST_FLAG
    }

    private val secureRandom = SecureRandom()
    private val header = byteArrayOf(
        'P'.code.toByte(),
        'N'.code.toByte(),
        'M'.code.toByte(),
        'F'.code.toByte(),
        1,
        0,
        0,
        0
    )
    private const val CIPHER_ALGORITHM = "AES/GCM/NoPadding"
    private const val AES_ALGORITHM = "AES"
    private const val FILE_AAD_PREFIX = "pneumo/v1/file:"
    private const val CHUNK_SIZE_BYTES = 65_536
    private const val TAG_SIZE_BYTES = 16
    private const val CIPHERTEXT_BLOCK_SIZE_BYTES = CHUNK_SIZE_BYTES + TAG_SIZE_BYTES
    private const val KEY_SIZE_BYTES = 32
    private const val NONCE_SIZE_BYTES = 12
    private const val TAG_SIZE_BITS = 128
    private const val NONCE_COUNTER_START = 3
    private const val NONCE_COUNTER_END = 10
    private const val LAST_FLAG_OFFSET = 11
    private const val BITS_PER_BYTE = 8
    private const val LAST_FLAG: Byte = 1
    private const val NOT_LAST_FLAG: Byte = 0
    private const val NO_BYTE = -1
}
