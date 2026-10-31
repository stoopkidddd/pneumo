package dev.pneumo.app.crypto

import dev.pneumo.app.protocol.KdfParams
import org.junit.Assert.assertEquals
import org.junit.Test

class KeyDerivationTest {
    @Test
    fun everyMasterKeyVectorMatches() {
        assertEquals(1L, CryptoVectorFixture.root.getValue("version").toString().toLong())
        for (element in CryptoVectorFixture.array("kdf")) {
            val vector = element.asObject()
            val params = vector.objectValue("params")
            val kdf = KdfParams(
                alg = params.string("alg"),
                iterations = params.long("iterations"),
                salt = params.string("salt")
            )

            val actual = MasterKey.derive(vector.string("passphrase"), kdf)

            assertSecretEquals(decodeBytes(vector.string("masterKey")), actual)
        }
    }

    @Test
    fun everyHkdfVectorMatches() {
        for (element in CryptoVectorFixture.array("hkdf")) {
            val vector = element.asObject()
            val actual = Hkdf.derive(
                inputKeyMaterial = decodeBytes(vector.string("masterKey")),
                label = vector.string("label"),
                length = vector.long("length").toInt()
            )

            assertSecretEquals(decodeBytes(vector.string("output")), actual)
        }
    }

    @Test
    fun everyKeyCheckVectorMatches() {
        for (element in CryptoVectorFixture.array("keyCheck")) {
            val vector = element.asObject()
            val actual = keyCheck(decodeBytes(vector.string("masterKey")))

            assertSecretEquals(decodeBytes(vector.string("output")), actual)
        }
    }

    @Test
    fun everyAuthKeyVectorMatches() {
        for (element in CryptoVectorFixture.array("authKey")) {
            val vector = element.asObject()
            val actual = deriveKeys(decodeBytes(vector.string("masterKey"))).authKey

            assertSecretEquals(decodeBytes(vector.string("output")), actual)
        }
    }
}
