package dev.pneumo.app

import android.app.Application

class PneumoApp : Application() {
    val container: AppContainer by lazy(LazyThreadSafetyMode.SYNCHRONIZED) {
        AppContainer(this)
    }
}
