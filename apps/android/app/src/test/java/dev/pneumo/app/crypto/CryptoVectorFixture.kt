package dev.pneumo.app.crypto

import java.security.MessageDigest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertTrue

internal object CryptoVectorFixture {
    val root: JsonObject by lazy {
        val stream = requireNotNull(javaClass.getResourceAsStream("/crypto/vectors/v1.json")) {
            "Missing shared crypto vectors"
        }
        stream.bufferedReader(Charsets.UTF_8).use { reader ->
            Json.parseToJsonElement(reader.readText()).jsonObject
        }
    }

    fun array(name: String): JsonArray = root.getValue(name).jsonArray

    fun file(): JsonObject = root.getValue("file").jsonObject
}

internal fun JsonObject.string(name: String): String = getValue(name).jsonPrimitive.content

internal fun JsonObject.long(name: String): Long = getValue(name).jsonPrimitive.content.toLong()

internal fun JsonObject.objectValue(name: String): JsonObject = getValue(name).jsonObject

internal fun decodeBytes(value: String): ByteArray = Base64Url.decode(value)

internal fun assertSecretEquals(expected: ByteArray, actual: ByteArray) {
    assertTrue("Cryptographic bytes differ", MessageDigest.isEqual(expected, actual))
}

internal fun JsonElement.asObject(): JsonObject = jsonObject
