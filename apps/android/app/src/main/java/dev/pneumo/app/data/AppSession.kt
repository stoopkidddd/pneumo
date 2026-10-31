package dev.pneumo.app.data

import dev.pneumo.app.net.ApiClient
import dev.pneumo.app.sync.PushRepository
import javax.crypto.SecretKey

/** Memory-only dependencies; credentials and decrypted history never enter saved UI state. */
class AppSession(
    val api: ApiClient,
    val pushes: PushRepository,
    val contentKey: SecretKey,
    val deviceId: String,
    val cache: SessionCache,
    val generation: Long
) {
    val maxEnvelopeBytes: Long = DEFAULT_MAX_ENVELOPE_BYTES

    private companion object {
        const val DEFAULT_MAX_ENVELOPE_BYTES = 65_536L
    }
}
