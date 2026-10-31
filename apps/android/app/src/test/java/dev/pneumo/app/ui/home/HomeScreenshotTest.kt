package dev.pneumo.app.ui.home

import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onRoot
import com.github.takahirom.roborazzi.captureRoboImage
import dev.pneumo.app.ui.theme.PneumoTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.ParameterizedRobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(ParameterizedRobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w360dp-h800dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class HomeScreenshotTest(private val fixture: HomePreviewCase, private val darkTheme: Boolean) {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun captureHome() {
        compose.setContent {
            PneumoTheme(darkTheme = darkTheme) { HomePreviewContent(fixture) }
        }
        val themeName = if (darkTheme) "dark" else "light"
        compose.onRoot().captureRoboImage("${fixture.fileName}-$themeName.png")
    }

    companion object {
        @JvmStatic
        @ParameterizedRobolectricTestRunner.Parameters(name = "{0}-{1}")
        fun parameters(): List<Array<Any>> = HomePreviewCase.entries.flatMap { fixture ->
            listOf(arrayOf<Any>(fixture, false), arrayOf<Any>(fixture, true))
        }
    }
}
