package dev.pneumo.app.ui.screens

import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onRoot
import com.github.takahirom.roborazzi.captureRoboImage
import dev.pneumo.app.net.ws.ConnectionState
import dev.pneumo.app.ui.theme.PneumoTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.ParameterizedRobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(ParameterizedRobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w360dp-h120dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ConnectionStatusScreenshotTest(private val state: ConnectionState, private val darkTheme: Boolean) {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun captureConnectionStatus() {
        compose.setContent {
            PneumoTheme(darkTheme = darkTheme) { ConnectionStatusFixture(state) }
        }
        val themeName = if (darkTheme) "dark" else "light"
        compose.onRoot().captureRoboImage("connection-${state.name.lowercase()}-$themeName.png")
    }

    companion object {
        @JvmStatic
        @ParameterizedRobolectricTestRunner.Parameters(name = "{0}-{1}")
        fun parameters(): List<Array<Any>> = ConnectionState.entries.flatMap { state ->
            listOf(arrayOf<Any>(state, false), arrayOf<Any>(state, true))
        }
    }
}
