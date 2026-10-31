package dev.pneumo.app.ui.home

import androidx.compose.runtime.saveable.Saver
import dev.pneumo.app.sync.DecryptedPush

internal class HomeScrollRequestConsumer(private var consumedNavigationId: Long? = null) {
    fun consume(navigationId: Long, targetPushId: String?, pushes: List<DecryptedPush>): Int? {
        if (targetPushId == null || consumedNavigationId == navigationId) return null
        val index = pushes.indexOfFirst { item -> item.push.id == targetPushId }
        return if (index < 0) {
            null
        } else {
            consumedNavigationId = navigationId
            index
        }
    }

    companion object {
        val Saver = Saver<HomeScrollRequestConsumer, Long>(
            save = { it.consumedNavigationId },
            restore = { HomeScrollRequestConsumer(it) }
        )
    }
}
