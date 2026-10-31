package dev.pneumo.app.crypto

import javax.crypto.Mac
import javax.crypto.SecretKey
import javax.crypto.spec.SecretKeySpec

class DerivedKeys internal constructor(contentKeyBytes: ByteArray, authKey: ByteArray) {
    val contentKey: SecretKey = SecretKeySpec(contentKeyBytes, AES_ALGORITHM)
    private val authKeyBytes = authKey.copyOf()

    val authKey: ByteArray
        get() = authKeyBytes.copyOf()

    companion object {
        private const val AES_ALGORITHM = "AES"
    }
}

fun deriveKeys(masterKey: ByteArray): DerivedKeys {
    requireMasterKey(masterKey)
    val contentKey = Hkdf.derive(masterKey, CONTENT_KEY_LABEL)
    val authKey = Hkdf.derive(masterKey, AUTH_KEY_LABEL)
    return try {
        DerivedKeys(contentKey, authKey)
    } finally {
        contentKey.fill(0)
        authKey.fill(0)
    }
}

fun keyCheck(masterKey: ByteArray): ByteArray {
    requireMasterKey(masterKey)
    val checkKey = Hkdf.derive(masterKey, CHECK_KEY_LABEL)
    return try {
        val mac = Mac.getInstance(HMAC_ALGORITHM)
        mac.init(SecretKeySpec(checkKey, HMAC_ALGORITHM))
        mac.doFinal(KEY_CHECK_LABEL.toByteArray(Charsets.UTF_8))
    } finally {
        checkKey.fill(0)
    }
}

internal fun requireMasterKey(masterKey: ByteArray) {
    require(masterKey.size == KEY_SIZE_BYTES) { "Expected a 32-byte master key" }
}

private const val CONTENT_KEY_LABEL = "pneumo/v1/content"
private const val AUTH_KEY_LABEL = "pneumo/v1/auth"
private const val CHECK_KEY_LABEL = "pneumo/v1/check"
private const val KEY_CHECK_LABEL = "pneumo/v1/key-check"
private const val HMAC_ALGORITHM = "HmacSHA256"
private const val KEY_SIZE_BYTES = 32
