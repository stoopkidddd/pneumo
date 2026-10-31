package dev.pneumo.app.data

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class KeystoreKeyWrapper : KeyWrapper {
    override fun wrap(plaintext: ByteArray): ByteArray {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, wrappingKey())
        cipher.updateAAD(AAD)
        val wrapped = ByteArray(NONCE_BYTES + cipher.getOutputSize(plaintext.size))
        cipher.iv.copyInto(wrapped)
        cipher.doFinal(plaintext, 0, plaintext.size, wrapped, NONCE_BYTES)
        return wrapped
    }

    override fun unwrap(wrapped: ByteArray): ByteArray {
        require(wrapped.size >= NONCE_BYTES + TAG_BYTES) { "Invalid wrapped credentials" }
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(
            Cipher.DECRYPT_MODE,
            wrappingKey(),
            GCMParameterSpec(TAG_BITS, wrapped, 0, NONCE_BYTES)
        )
        cipher.updateAAD(AAD)
        return cipher.doFinal(wrapped, NONCE_BYTES, wrapped.size - NONCE_BYTES)
    }

    private companion object {
        const val PROVIDER = "AndroidKeyStore"
        const val ALIAS = "pneumo_wrap"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val KEY_BITS = 256
        const val NONCE_BYTES = 12
        const val TAG_BYTES = 16
        const val TAG_BITS = TAG_BYTES * 8
        val AAD = "pneumo/v1/session".toByteArray(Charsets.UTF_8)

        @Synchronized
        fun wrappingKey(): SecretKey {
            val store = KeyStore.getInstance(PROVIDER).apply { load(null) }
            val existing = store.getKey(ALIAS, null)
            if (existing != null) return existing as SecretKey
            val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, PROVIDER)
            generator.init(
                KeyGenParameterSpec.Builder(
                    ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
                ).setKeySize(KEY_BITS)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setUserAuthenticationRequired(false)
                    .build()
            )
            return generator.generateKey()
        }
    }
}
