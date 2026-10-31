plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.roborazzi)
    alias(libs.plugins.ksp)
}

abstract class SharedFixtureSync : Sync() {
    @get:OutputDirectory
    abstract val fixtureDirectory: DirectoryProperty
}

val syncSharedFixtures = tasks.register<SharedFixtureSync>("syncSharedFixtures") {
    fixtureDirectory.set(layout.buildDirectory.dir("generated/sharedFixtures"))
    from(rootProject.file("../../packages/crypto/vectors")) {
        include("*.json")
        into("crypto/vectors")
    }
    from(rootProject.file("../../packages/protocol/fixtures")) {
        into("protocol/fixtures")
    }
    into(fixtureDirectory)
}

tasks.withType<Test>().configureEach {
    dependsOn(syncSharedFixtures)
}

android {
    namespace = "dev.pneumo.app"
    compileSdk {
        version = release(37) {
            minorApiLevel = 2
        }
    }
    buildToolsVersion = "37.0.0"

    defaultConfig {
        applicationId = "dev.pneumo.app"
        minSdk = 26
        targetSdk = 37
        versionCode = 1
        versionName = "0.0.1"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"))
        }
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    lint {
        warningsAsErrors = true
        baseline = file("lint-baseline.xml")
        // Dependency-update checks make pinned commits fail when upstream releases change.
        disable += setOf("AndroidGradlePluginVersion", "GradleDependency", "NewerVersionAvailable")
    }

    testOptions {
        unitTests.isIncludeAndroidResources = true
        managedDevices {
            localDevices {
                create("pixel6Api34") {
                    device = "Pixel 6"
                    apiLevel = 34
                    systemImageSource = "aosp-atd"
                }
            }
        }
    }
}

androidComponents.onVariants { variant ->
    variant.hostTests.values.forEach { test ->
        test.sources.resources?.addGeneratedSourceDirectory(syncSharedFixtures) { it.fixtureDirectory }
    }
}

kotlin {
    jvmToolchain(17)
}

@OptIn(com.github.takahirom.roborazzi.ExperimentalRoborazziApi::class)
roborazzi {
    outputDir.set(file("src/test/screenshots"))
    separateOutputDirs.set(true)
}

ksp {
    arg("room.schemaLocation", "$projectDir/schemas")
}

dependencies {
    implementation(libs.androidx.activity.compose)
    // Activity's transitive Lifecycle 2.9 lint checks use APIs removed by current lint.
    implementation(libs.androidx.lifecycle.runtime)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.navigation.compose)
    implementation(libs.androidx.camera.camera2)
    implementation(libs.androidx.camera.lifecycle)
    implementation(libs.androidx.camera.view)
    implementation(libs.zxing.core)
    implementation(libs.compose.material.icons.core)
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.material3)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.serialization.json)
    implementation(libs.okhttp)
    implementation(libs.datastore.preferences)
    implementation(libs.coroutines.core)
    implementation(libs.androidx.room.runtime)
    implementation(libs.androidx.room.ktx)
    implementation(libs.androidx.work.runtime.ktx)
    debugImplementation(libs.compose.ui.tooling)
    debugImplementation(libs.compose.ui.test.manifest)

    testImplementation(libs.junit)
    testImplementation(libs.robolectric)
    testImplementation(libs.compose.ui.test.junit4)
    testImplementation(libs.roborazzi)
    testImplementation(libs.roborazzi.compose)
    testImplementation(libs.turbine)
    testImplementation(libs.coroutines.test)
    testImplementation(libs.mockwebserver)
    testImplementation(libs.androidx.room.testing)
    testImplementation(libs.androidx.work.testing)
    ksp(libs.androidx.room.compiler)

    androidTestImplementation(platform(libs.compose.bom))
    androidTestImplementation(libs.androidx.test.ext.junit)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.compose.ui.test.junit4)
}
