buildscript {
    dependencies {
        classpath(libs.kotlin.gradle.plugin)
    }
}

plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.roborazzi) apply false
    alias(libs.plugins.spotless)
    alias(libs.plugins.detekt)
}

spotless {
    kotlin {
        target("app/src/**/*.kt")
        ktlint(libs.versions.ktlint.get())
    }
    kotlinGradle {
        target("*.gradle.kts", "app/*.gradle.kts")
        ktlint(libs.versions.ktlint.get())
    }
}

detekt {
    toolVersion = libs.versions.detekt.get()
    source.setFrom("app/src/main/java", "app/src/test/java", "app/src/androidTest/java")
    config.setFrom("config/detekt/detekt.yml")
    buildUponDefaultConfig = true
    basePath.set(layout.projectDirectory)
}

dependencies {
    detektPlugins(libs.compose.rules)
}
