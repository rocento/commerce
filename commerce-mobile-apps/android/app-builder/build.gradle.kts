plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.plugin.serialization")
}
android {
    namespace = "com.rocento.mobile.builder"
    compileSdk { version = release(37) { minorApiLevel = 1 } }
    buildToolsVersion = "36.0.0"
    defaultConfig { minSdk = 26 }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
dependencies {
    api(project(":core"))
    testImplementation("junit:junit:4.13.2")
    testImplementation("com.squareup.okhttp3:mockwebserver:5.5.0")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.11.0")
}

// Register fixture assets through the supported AGP variant API.
androidComponents.onVariants { variant ->
    variant.hostTests.values.forEach { test ->
        test.sources.resources?.addStaticSourceDirectory("../core/src/main/assets")
    }
}
