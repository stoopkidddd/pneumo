package dev.pneumo.app.crypto

import dev.pneumo.app.protocol.KdfParams
import java.text.Normalizer
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.PBEKeySpec

object MasterKey {
    fun derive(passphrase: String, kdf: KdfParams): ByteArray {
        require(kdf.alg == KDF_ALGORITHM) { "Unsupported KDF algorithm" }
        require(kdf.iterations in 1..Int.MAX_VALUE.toLong()) { "Invalid KDF iteration count" }
        val salt = Base64Url.decode(kdf.salt)
        require(salt.size == SALT_SIZE_BYTES) { "Expected a 16-byte KDF salt" }
        val password = Normalizer.normalize(passphrase, Normalizer.Form.NFC).toCharArray()
        val spec = PBEKeySpec(password, salt, kdf.iterations.toInt(), MASTER_KEY_BITS)
        return try {
            SecretKeyFactory.getInstance(JCA_ALGORITHM).generateSecret(spec).encoded
        } finally {
            spec.clearPassword()
            password.fill(NULL_CHARACTER)
            salt.fill(0)
        }
    }

    private const val KDF_ALGORITHM = "PBKDF2-SHA256"
    private const val JCA_ALGORITHM = "PBKDF2WithHmacSHA256"
    private const val SALT_SIZE_BYTES = 16
    private const val MASTER_KEY_BITS = 256
    private const val NULL_CHARACTER = '\u0000'
}
