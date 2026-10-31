package dev.pneumo.app.crypto

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.security.MessageDigest
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class FileCryptoTest {
    @Test
    fun everyFileVectorEncryptsAndDecrypts() {
        val file = CryptoVectorFixture.file()
        val fileKey = decodeBytes(file.string("key"))
        val fileId = file.string("fileId")
        for (element in file.getValue("cases").asObjectArray()) {
            val vector = element.asObject()
            val plaintext = patternedBytes(vector.long("size").toInt())
            val ciphertext = encrypt(plaintext, fileKey, fileId)

            assertEquals(vector.long("ciphertextLength"), ciphertext.size.toLong())
            vector["ciphertext"]?.let { expected ->
                assertSecretEquals(decodeBytes(expected.jsonPrimitive.content), ciphertext)
            }
            vector["sha256"]?.let { expected ->
                val digest = MessageDigest.getInstance(SHA_256).digest(ciphertext)
                assertSecretEquals(decodeBytes(expected.jsonPrimitive.content), digest)
            }
            assertSecretEquals(plaintext, decrypt(ciphertext, fileKey, fileId))
        }
    }

    @Test
    fun everyNegativeFileVectorIsRejected() {
        val file = CryptoVectorFixture.file()
        val fileKey = decodeBytes(file.string("key"))
        val fileId = file.string("fileId")
        val cases = file.getValue("cases").asObjectArray()
            .associateBy { it.asObject().long("size") }
        for (element in CryptoVectorFixture.array("negative")) {
            val vector = element.asObject()
            if (vector.string("operation") != "decryptFile") continue
            val source = vector.objectValue("source")
            val positive = requireNotNull(cases[source.long("size")]).asObject()
            val original = decodeBytes(positive.string("ciphertext"))
            val mutation = vector.objectValue("mutation")
            var decryptFileId = fileId
            val mutated = when (mutation.string("type")) {
                "xor-last-byte" -> original.copyOf().also { bytes ->
                    bytes[bytes.lastIndex] =
                        (bytes.last().toInt() xor mutation.long("xor").toInt()).toByte()
                }

                "xor-byte" -> original.copyOf().also { bytes ->
                    val index = mutation.long("index").toInt()
                    bytes[index] = (bytes[index].toInt() xor mutation.long("xor").toInt()).toByte()
                }

                "truncate" -> original.copyOf(mutation.long("length").toInt())

                "append" -> original + decodeBytes(mutation.string("bytes"))

                "replace-file-id" -> {
                    decryptFileId = mutation.string("value")
                    original
                }

                else -> error("Unknown file mutation")
            }

            assertRejects(mutated, fileKey, decryptFileId)
        }
    }

    @Test
    fun decryptsIndependentOfOddInputReadSizes() {
        val file = CryptoVectorFixture.file()
        val fileKey = decodeBytes(file.string("key"))
        val fileId = file.string("fileId")
        val plaintext = patternedBytes(STREAM_TEST_SIZE)
        val ciphertext = encrypt(plaintext, fileKey, fileId)

        for (readSize in oddReadSizes) {
            val output = ByteArrayOutputStream()
            FileCrypto.decrypt(
                ChunkedInputStream(ciphertext, readSize),
                output,
                fileKey,
                fileId
            )
            assertSecretEquals(plaintext, output.toByteArray())
        }
    }

    @Test
    fun truncationAtEveryChunkBoundaryIsRejected() {
        val file = CryptoVectorFixture.file()
        val fileKey = decodeBytes(file.string("key"))
        val fileId = file.string("fileId")
        val ciphertext = encrypt(patternedBytes(STREAM_TEST_SIZE), fileKey, fileId)
        val chunkCount = (STREAM_TEST_SIZE + CHUNK_SIZE_BYTES - 1) / CHUNK_SIZE_BYTES

        for (completedChunks in 0 until chunkCount) {
            val length = HEADER_SIZE_BYTES + completedChunks * CIPHERTEXT_BLOCK_SIZE_BYTES
            assertRejects(ciphertext.copyOf(length), fileKey, fileId)
        }
    }

    private fun encrypt(plaintext: ByteArray, fileKey: ByteArray, fileId: String): ByteArray {
        val output = ByteArrayOutputStream()
        FileCrypto.encrypt(ByteArrayInputStream(plaintext), output, fileKey, fileId)
        return output.toByteArray()
    }

    private fun decrypt(ciphertext: ByteArray, fileKey: ByteArray, fileId: String): ByteArray {
        val output = ByteArrayOutputStream()
        FileCrypto.decrypt(ByteArrayInputStream(ciphertext), output, fileKey, fileId)
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

    private fun patternedBytes(size: Int): ByteArray =
        ByteArray(size) { index -> ((index * PATTERN_MULTIPLIER + PATTERN_ADDEND) and BYTE_MASK).toByte() }

    private class ChunkedInputStream(private val bytes: ByteArray, private val chunkSize: Int) : InputStream() {
        private var position = 0
        private var positionInChunk = 0

        override fun read(): Int {
            if (position == bytes.size) return -1
            val value = bytes[position].toInt() and BYTE_MASK
            position += 1
            positionInChunk = (positionInChunk + 1) % chunkSize
            return value
        }

        override fun read(destination: ByteArray, offset: Int, length: Int): Int {
            if (position == bytes.size) return -1
            val remainingInChunk = chunkSize - positionInChunk
            val count = minOf(length, remainingInChunk, bytes.size - position)
            bytes.copyInto(destination, offset, position, position + count)
            position += count
            positionInChunk = (positionInChunk + count) % chunkSize
            return count
        }
    }

    private companion object {
        val oddReadSizes = intArrayOf(1, ODD_READ_SIZE_SEVEN, ODD_READ_SIZE_ABOVE_BLOCK)
        const val SHA_256 = "SHA-256"
        const val STREAM_TEST_SIZE = 200_000
        const val CHUNK_SIZE_BYTES = 65_536
        const val TAG_SIZE_BYTES = 16
        const val CIPHERTEXT_BLOCK_SIZE_BYTES = CHUNK_SIZE_BYTES + TAG_SIZE_BYTES
        const val HEADER_SIZE_BYTES = 8
        const val PATTERN_MULTIPLIER = 31
        const val PATTERN_ADDEND = 17
        const val ODD_READ_SIZE_SEVEN = 7
        const val ODD_READ_SIZE_ABOVE_BLOCK = 65_553
        const val BYTE_MASK = 255
    }
}

private fun kotlinx.serialization.json.JsonElement.asObjectArray() = jsonArray
