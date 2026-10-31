package dev.pneumo.app.sync

import dev.pneumo.app.crypto.PushCrypto
import dev.pneumo.app.data.db.PneumoDatabase
import dev.pneumo.app.data.db.PushEntity
import dev.pneumo.app.data.db.toDto
import dev.pneumo.app.protocol.PushDTO
import dev.pneumo.app.protocol.PushPayload
import javax.crypto.SecretKey
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

data class DecryptedPush(val push: PushDTO, val payload: PushPayload, val notified: Boolean)

class PushRepository(database: PneumoDatabase, private val contentKey: SecretKey) {
    private val pushes = database.pushes()

    suspend fun get(id: String): DecryptedPush? = pushes.find(id)?.decrypt()

    suspend fun list(): List<DecryptedPush> = pushes.list().map { it.decrypt() }

    fun observeAll(): Flow<List<DecryptedPush>> = pushes.observeAll().map { stored ->
        stored.map { it.decrypt() }
    }

    private fun PushEntity.decrypt(): DecryptedPush {
        val push = toDto()
        return DecryptedPush(
            push = push,
            payload = PushCrypto.decrypt(contentKey, push.id, push.envelope),
            notified = notified
        )
    }
}
