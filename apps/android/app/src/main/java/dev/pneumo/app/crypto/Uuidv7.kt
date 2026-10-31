package dev.pneumo.app.crypto

import java.security.SecureRandom

object Uuidv7 {
    fun generate(): String = generate(System.currentTimeMillis(), secureRandom)

    fun isValid(value: String): Boolean = uuidV7Pattern.matches(value)

    internal fun generate(timestampMillis: Long, random: SecureRandom): String {
        require(timestampMillis in 0..MAX_TIMESTAMP) { "Timestamp is outside the UUIDv7 range" }
        val bytes = ByteArray(UUID_SIZE_BYTES)
        random.nextBytes(bytes)
        var remainingTimestamp = timestampMillis
        for (index in TIMESTAMP_LAST_INDEX downTo 0) {
            bytes[index] = remainingTimestamp.toByte()
            remainingTimestamp = remainingTimestamp ushr BITS_PER_BYTE
        }
        bytes[VERSION_BYTE_INDEX] =
            ((bytes[VERSION_BYTE_INDEX].toInt() and VERSION_RANDOM_MASK) or VERSION_BITS).toByte()
        bytes[VARIANT_BYTE_INDEX] =
            ((bytes[VARIANT_BYTE_INDEX].toInt() and VARIANT_RANDOM_MASK) or VARIANT_BITS).toByte()
        return format(bytes)
    }

    private fun format(bytes: ByteArray): String = buildString(UUID_STRING_LENGTH) {
        bytes.forEachIndexed { index, byte ->
            if (isHyphenPosition(index)) append('-')
            val value = byte.toInt() and UNSIGNED_BYTE_MASK
            append(HEX_DIGITS[value ushr NIBBLE_BITS])
            append(HEX_DIGITS[value and NIBBLE_MASK])
        }
    }

    private fun isHyphenPosition(index: Int): Boolean = index == FIRST_HYPHEN_BYTE ||
        index == SECOND_HYPHEN_BYTE ||
        index == THIRD_HYPHEN_BYTE ||
        index == FOURTH_HYPHEN_BYTE

    private val secureRandom = SecureRandom()
    private val uuidV7Pattern =
        Regex("^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
    private const val MAX_TIMESTAMP = 0xffff_ffff_ffffL
    private const val UUID_SIZE_BYTES = 16
    private const val UUID_STRING_LENGTH = 36
    private const val TIMESTAMP_LAST_INDEX = 5
    private const val VERSION_BYTE_INDEX = 6
    private const val VARIANT_BYTE_INDEX = 8
    private const val FIRST_HYPHEN_BYTE = 4
    private const val SECOND_HYPHEN_BYTE = 6
    private const val THIRD_HYPHEN_BYTE = 8
    private const val FOURTH_HYPHEN_BYTE = 10
    private const val VERSION_RANDOM_MASK = 0x0f
    private const val VERSION_BITS = 0x70
    private const val VARIANT_RANDOM_MASK = 0x3f
    private const val VARIANT_BITS = 0x80
    private const val BITS_PER_BYTE = 8
    private const val UNSIGNED_BYTE_MASK = 0xff
    private const val NIBBLE_BITS = 4
    private const val NIBBLE_MASK = 0x0f
    private const val HEX_DIGITS = "0123456789abcdef"
}
