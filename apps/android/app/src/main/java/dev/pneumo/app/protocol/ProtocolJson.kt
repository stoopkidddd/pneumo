@file:OptIn(kotlinx.serialization.ExperimentalSerializationApi::class)

package dev.pneumo.app.protocol

import kotlinx.serialization.json.Json

val ProtocolJson: Json = Json {
    ignoreUnknownKeys = true
    encodeDefaults = false
    explicitNulls = true
}
