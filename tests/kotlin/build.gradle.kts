import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    kotlin("multiplatform") version "2.4.20"
    id("com.android.kotlin.multiplatform.library") version "8.13.2"
}

// Compile the production sources without building NativeScript or touching BLE.
kotlin {
    android {
        namespace = "com.faceclaw.protocoltests"
        compileSdk = 35
        minSdk = 24
        withJava()
        compilerOptions { jvmTarget.set(JvmTarget.JVM_17) }
        withHostTestBuilder {}.configure {}
    }
    iosArm64()
    iosSimulatorArm64()
    sourceSets {
        commonMain { kotlin.srcDir("../../native/kotlin/shared/src/commonMain/kotlin") }
        androidMain { kotlin.srcDir("../../native/kotlin/shared/src/androidMain/kotlin") }
        iosMain { kotlin.srcDir("../../native/kotlin/shared/src/iosMain/kotlin") }
        commonTest.dependencies { implementation(kotlin("test")) }
    }
}

// The font is already shipped in the app; avoid copying megabytes into test fixtures.
val generateFixturePaths = tasks.register("generateFixturePaths") {
    val output = layout.buildDirectory.file("generated/fixtures/com/faceclaw/app/FixturePaths.kt")
    outputs.dir(layout.buildDirectory.dir("generated/fixtures"))
    doLast {
        val font = file("../../app/fonts/source-han-sans/SourceHanSansSC-Light-20.lvgl.bin").canonicalPath
        output.get().asFile.apply {
            parentFile.mkdirs()
            writeText("package com.faceclaw.app\ninternal const val TEST_FONT_PATH = \"${font.replace("\\", "\\\\").replace("\"", "\\\"")}\"\n")
        }
    }
}
kotlin.sourceSets.commonTest { kotlin.srcDir(generateFixturePaths) }
