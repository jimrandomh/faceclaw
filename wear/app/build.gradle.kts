plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

// Match the phone's marketing version, with a distinct Play upload code.
val faceclawVersionName = Regex("""FACECLAW_VERSION = "([^"]+)"""")
    .find(rootProject.file("../app/version.ts").readText())?.groupValues?.get(1)
    ?: error("Could not read FACECLAW_VERSION from app/version.ts")
val faceclawVersionParts = (faceclawVersionName.substringBefore('-').split('.') + listOf("0", "0"))
    .take(3).map { it.toInt() }
val faceclawBuildRevision = System.getenv("FACECLAW_ANDROID_BUILD_REVISION") ?: "0"
require(faceclawBuildRevision.matches(Regex("[0-4]"))) {
    "FACECLAW_ANDROID_BUILD_REVISION must be an integer from 0 to 4"
}
val faceclawVersionCode = (faceclawVersionParts[0] * 10000 + faceclawVersionParts[1] * 100 + faceclawVersionParts[2]) * 10 + faceclawBuildRevision.toInt() * 2 + 1

android {
    namespace = "com.faceclaw.wear"
    compileSdk = 36

    defaultConfig {
        // Must equal the phone app's id (nativescript.config.ts): the Wearable
        // Data Layer only routes between apps with the same package name and
        // signing key.
        applicationId = "com.faceclaw.app"
        minSdk = 30
        targetSdk = 36
        versionCode = faceclawVersionCode
        versionName = faceclawVersionName
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    lint {
        // androidx.lifecycle 2.9.x ships a NullSafeMutableLiveData lint check
        // that crashes under this AGP's lint (Kotlin analysis API mismatch:
        // "Found class KaCallableMemberCall, but interface was expected").
        // We don't use LiveData, so nothing is lost by disabling it.
        disable += "NullSafeMutableLiveData"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
        // Warnings print only when a file is recompiled; fail instead so they
        // can't scroll by unnoticed (as in native/kotlin/shared).
        allWarningsAsErrors = true
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2025.05.01")
    implementation(composeBom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.runtime:runtime")
    debugImplementation("androidx.compose.ui:ui-tooling")

    implementation("androidx.wear.compose:compose-foundation:1.4.1")
    implementation("androidx.wear.compose:compose-material:1.4.1")
    implementation("androidx.wear.compose:compose-navigation:1.4.1")

    implementation("androidx.activity:activity-compose:1.10.1")
    implementation("androidx.core:core-ktx:1.16.0")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.9.2")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.9.2")
    // RemoteInputIntentHelper: the system keyboard / voice / emoji text entry.
    implementation("androidx.wear:wear-input:1.1.0")
    // AmbientLifecycleObserver: the always-on (ambient) display callbacks.
    implementation("androidx.wear:wear:1.3.0")

    implementation("com.google.android.gms:play-services-wearable:19.0.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-play-services:1.10.1")
}
