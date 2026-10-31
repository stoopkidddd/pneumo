package dev.pneumo.app

import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onRoot
import com.github.takahirom.roborazzi.captureRoboImage
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w360dp-h800dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class PneumoScreenshotTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun lightPreview() {
        compose.setContent { PneumoLightPreview() }
        compose.onRoot().captureRoboImage("pneumo-light.png")
    }

    @Test
    fun darkPreview() {
        compose.setContent { PneumoDarkPreview() }
        compose.onRoot().captureRoboImage("pneumo-dark.png")
    }
}
