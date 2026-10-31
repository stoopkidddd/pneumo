package dev.pneumo.app.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

private val LightColors =
    lightColorScheme(
        primary = BrandColors.Light.Accent,
        onPrimary = BrandColors.Light.AccentContrast,
        primaryContainer = BrandColors.Light.Surface,
        onPrimaryContainer = BrandColors.Light.Text,
        secondary = BrandColors.Light.Surface,
        onSecondary = BrandColors.Light.Text,
        secondaryContainer = BrandColors.Light.Surface,
        onSecondaryContainer = BrandColors.Light.Text,
        tertiary = BrandColors.Light.Surface,
        onTertiary = BrandColors.Light.Text,
        tertiaryContainer = BrandColors.Light.Surface,
        onTertiaryContainer = BrandColors.Light.Text,
        background = BrandColors.Light.Background,
        onBackground = BrandColors.Light.Text,
        surface = BrandColors.Light.Surface,
        onSurface = BrandColors.Light.Text,
        surfaceVariant = BrandColors.Light.SurfaceRaised,
        onSurfaceVariant = BrandColors.Light.TextMuted,
        surfaceDim = BrandColors.Light.Background,
        surfaceBright = BrandColors.Light.Surface,
        surfaceContainerLowest = BrandColors.Light.Background,
        surfaceContainerLow = BrandColors.Light.Surface,
        surfaceContainer = BrandColors.Light.Surface,
        surfaceContainerHigh = BrandColors.Light.SurfaceRaised,
        surfaceContainerHighest = BrandColors.Light.SurfaceRaised,
        surfaceTint = BrandColors.Light.Surface,
        inverseSurface = BrandColors.Light.SurfaceRaised,
        inverseOnSurface = BrandColors.Light.Text,
        inversePrimary = BrandColors.Light.Accent,
        error = BrandColors.Light.Danger,
        onError = BrandColors.Light.Surface,
        errorContainer = BrandColors.Light.Surface,
        onErrorContainer = BrandColors.Light.Danger,
        outline = BrandColors.Light.Border,
        outlineVariant = BrandColors.Light.Border,
        scrim = BrandColors.Light.Text
    )

private val DarkColors =
    darkColorScheme(
        primary = BrandColors.Dark.Accent,
        onPrimary = BrandColors.Dark.AccentContrast,
        primaryContainer = BrandColors.Dark.Surface,
        onPrimaryContainer = BrandColors.Dark.Text,
        secondary = BrandColors.Dark.Surface,
        onSecondary = BrandColors.Dark.Text,
        secondaryContainer = BrandColors.Dark.Surface,
        onSecondaryContainer = BrandColors.Dark.Text,
        tertiary = BrandColors.Dark.Surface,
        onTertiary = BrandColors.Dark.Text,
        tertiaryContainer = BrandColors.Dark.Surface,
        onTertiaryContainer = BrandColors.Dark.Text,
        background = BrandColors.Dark.Background,
        onBackground = BrandColors.Dark.Text,
        surface = BrandColors.Dark.Surface,
        onSurface = BrandColors.Dark.Text,
        surfaceVariant = BrandColors.Dark.SurfaceRaised,
        onSurfaceVariant = BrandColors.Dark.TextMuted,
        surfaceDim = BrandColors.Dark.Background,
        surfaceBright = BrandColors.Dark.SurfaceRaised,
        surfaceContainerLowest = BrandColors.Dark.Background,
        surfaceContainerLow = BrandColors.Dark.Surface,
        surfaceContainer = BrandColors.Dark.Surface,
        surfaceContainerHigh = BrandColors.Dark.SurfaceRaised,
        surfaceContainerHighest = BrandColors.Dark.SurfaceRaised,
        surfaceTint = BrandColors.Dark.Surface,
        inverseSurface = BrandColors.Dark.SurfaceRaised,
        inverseOnSurface = BrandColors.Dark.Text,
        inversePrimary = BrandColors.Dark.Accent,
        error = BrandColors.Dark.Danger,
        onError = BrandColors.Dark.Surface,
        errorContainer = BrandColors.Dark.Surface,
        onErrorContainer = BrandColors.Dark.Danger,
        outline = BrandColors.Dark.Border,
        outlineVariant = BrandColors.Dark.Border,
        scrim = BrandColors.Dark.Text
    )

private fun appTextStyle(size: Int, lineHeight: Int, weight: FontWeight = FontWeight.Normal) = TextStyle(
    fontFamily = FontFamily.Default,
    fontWeight = weight,
    fontSize = size.sp,
    lineHeight = lineHeight.sp,
    letterSpacing = 0.sp
)

private val CaptionStyle = appTextStyle(size = 12, lineHeight = 16)
private val LabelStyle = appTextStyle(size = 14, lineHeight = 20)
private val BodyStyle = appTextStyle(size = 16, lineHeight = 24)
private val HeadingStyle = appTextStyle(size = 20, lineHeight = 28, weight = FontWeight.SemiBold)
private val TitleStyle = appTextStyle(size = 28, lineHeight = 36, weight = FontWeight.SemiBold)
private val DisplayStyle = appTextStyle(size = 40, lineHeight = 48, weight = FontWeight.SemiBold)

private val AppTypography =
    Typography(
        displayLarge = DisplayStyle,
        displayMedium = DisplayStyle,
        displaySmall = DisplayStyle,
        headlineLarge = TitleStyle,
        headlineMedium = TitleStyle,
        headlineSmall = TitleStyle,
        titleLarge = TitleStyle,
        titleMedium = HeadingStyle,
        titleSmall = HeadingStyle,
        bodyLarge = BodyStyle,
        bodyMedium = BodyStyle,
        bodySmall = CaptionStyle,
        labelLarge = LabelStyle,
        labelMedium = LabelStyle,
        labelSmall = CaptionStyle
    )

private val AppShapes =
    Shapes(
        extraSmall = RoundedCornerShape(6.dp),
        small = RoundedCornerShape(6.dp),
        medium = RoundedCornerShape(10.dp),
        large = RoundedCornerShape(14.dp),
        extraLarge = RoundedCornerShape(14.dp)
    )

@Composable
fun PneumoTheme(darkTheme: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = if (darkTheme) DarkColors else LightColors,
        typography = AppTypography,
        shapes = AppShapes,
        content = content
    )
}
