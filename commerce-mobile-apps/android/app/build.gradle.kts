plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.serialization")
    id("org.jetbrains.kotlin.plugin.compose")
}

val appBuilder = providers.gradleProperty("appBuilder").orNull == "true"

android {
    namespace = "com.rocento.mobile"
    compileSdk { version = release(37) { minorApiLevel = 1 } }
    buildToolsVersion = "36.0.0"
    defaultConfig {
        val previewOrigin = providers.gradleProperty("previewOrigin").orNull ?: "https://grocery.rocento.com/api"
        require(previewOrigin.matches(Regex("https://[A-Za-z0-9.:-]+(?:/[A-Za-z0-9/_-]*)?"))) { "Preview origin must be a trusted HTTPS URL" }
        buildConfigField("String", "PREVIEW_ORIGIN", "\"$previewOrigin\"")
        buildConfigField("boolean", "PUSH_NOTIFICATIONS", (providers.gradleProperty("pushNotifications").orNull == "true").toString())
        applicationId = "com.rocento.mobile.preview"
        minSdk = 26
        targetSdk = 37
        versionCode = 5
        versionName = "1.3.0"
        buildConfigField("boolean", "PRODUCTION", "false")
        buildConfigField("String", "STORE", "\"grocery\"")
        buildConfigField("String", "TENANT", "\"312f9ac8-4888-4d35-92a0-e5fdb3bf59b8\"")
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    flavorDimensions += "merchant"
    productFlavors {
        create("rocento") {
            dimension = "merchant"
            applicationId = "com.rocento.grocery"
            buildConfigField("int", "MERCHANT", "1")
            buildConfigField("boolean", "PRODUCTION", "true")
            resValue("string", "app_name", "Rocento")
        }

        create("electronics") {
            dimension = "merchant"
            applicationId = "com.rocento.electronics"
            buildConfigField("int", "MERCHANT", "1")
            buildConfigField("boolean", "PRODUCTION", "true")
            buildConfigField("String", "STORE", "\"electronics\"")
            buildConfigField("String", "TENANT", "\"07cccc3d-6a89-5f7d-811c-c5ff9b1de2ca\"")
            resValue("string", "app_name", "Electronics")
        }
        create("jewelry") {
            dimension = "merchant"
            applicationId = "com.rocento.jewelry"
            buildConfigField("int", "MERCHANT", "1")
            buildConfigField("boolean", "PRODUCTION", "true")
            buildConfigField("String", "STORE", "\"jewelry\"")
            buildConfigField("String", "TENANT", "\"93182ade-4864-50f7-ac66-ad8a4bc7b5f0\"")
            resValue("string", "app_name", "Jewelry")
        }
        create("pharmacy") {
            dimension = "merchant"
            applicationId = "com.rocento.pharmacy"
            buildConfigField("int", "MERCHANT", "1")
            buildConfigField("boolean", "PRODUCTION", "true")
            buildConfigField("String", "STORE", "\"pharmacy\"")
            buildConfigField("String", "TENANT", "\"f2c2b1ec-b9ea-53e3-9800-a61f9cd1dc86\"")
            resValue("string", "app_name", "Pharmacy")
        }
        create("market") {
            dimension = "merchant"
            applicationIdSuffix = ".market"
            buildConfigField("int", "MERCHANT", "1")
            resValue("string", "app_name", "Demo Market")
        }
        create("boutique") {
            dimension = "merchant"
            applicationIdSuffix = ".boutique"
            buildConfigField("int", "MERCHANT", "2")
            resValue("string", "app_name", "Demo Boutique")
        }
    }
    buildFeatures {
        compose = true
        buildConfig = true
        resValues = true
    }
    buildTypes {
        getByName("release") {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    packaging { resources.excludes += "/META-INF/{AL2.0,LGPL2.1}" }
    sourceSets["main"].kotlin.directories.add(if (appBuilder) "src/appBuilder/java" else "src/standalone/java")
    if (appBuilder) sourceSets["androidTest"].kotlin.directories.add("src/appBuilderAndroidTest/java")
}

dependencies {
    implementation(platform("com.google.firebase:firebase-bom:35.0.0"))
    implementation("com.google.firebase:firebase-messaging")
    implementation(project(":core"))
    if (appBuilder) implementation(project(":app-builder"))
    implementation(platform("androidx.compose:compose-bom:2026.09.00"))
    implementation("androidx.activity:activity-compose:1.13.0")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-core")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.11.0")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.11.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("com.squareup.okhttp3:mockwebserver:5.5.0")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.11.0")
    androidTestImplementation(platform("androidx.compose:compose-bom:2026.09.00"))
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    // Compose 1.12 still pulls Espresso 3.5; 3.7 fixes input injection on API 37.
    androidTestImplementation("androidx.test.espresso:espresso-core:3.7.0")
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
    androidTestImplementation("androidx.test:runner:1.7.0")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
    debugImplementation("androidx.compose.ui:ui-tooling")
}

// An assemble task has no destination identity to compare. Gate every Gradle
// install and connected-test action after assembly, before AGP installs APKs.
androidComponents.onVariants { variant ->
    val suffix = variant.name.replaceFirstChar { it.uppercase() }
    val flavor = variant.productFlavors.single { it.first == "merchant" }.second
    val appApks = variant.artifacts.get(com.android.build.api.artifact.SingleArtifact.APK)
    val testApks = variant.androidTest?.artifacts?.get(com.android.build.api.artifact.SingleArtifact.APK)
    tasks.configureEach {
        val checksTests = name == "connected${suffix}AndroidTest" || name == "install${suffix}AndroidTest"
        if (name == "install$suffix" || checksTests) {
            if (checksTests) dependsOn("assemble$suffix", "assemble${suffix}AndroidTest")
            doFirst {
                fun singleApk(directory: java.io.File): java.io.File =
                    directory.listFiles { file -> file.extension == "apk" }?.singleOrNull()
                        ?: throw GradleException("Signing gate requires exactly one APK in $directory")
                val arguments = mutableListOf(
                    "python3", rootProject.file("../tools/check_android_signing.py").absolutePath,
                    singleApk(appApks.get().asFile).absolutePath,
                    "--sdk", androidComponents.sdkComponents.sdkDirectory.get().asFile.absolutePath,
                    "--flavor", flavor, "--connected-devices",
                    "--report", layout.buildDirectory.file("reports/signing/$name.json").get().asFile.absolutePath,
                )
                if (checksTests) {
                    val tests = testApks ?: throw GradleException("No instrumented APK for ${variant.name}")
                    arguments += listOf("--test-apk", singleApk(tests.get().asFile).absolutePath)
                }
                providers.exec { commandLine(arguments) }.result.get().assertNormalExitValue()
            }
        }
    }
}
