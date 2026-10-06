import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.jetbrains.kotlin.gradle.plugin.mpp.apple.XCFramework

plugins {
    kotlin("multiplatform")
    id("com.android.kotlin.multiplatform.library")
}
kotlin {
    compilerOptions {
        // expect/actual classes are Beta in Kotlin 2.x; opt in deliberately.
        freeCompilerArgs.add("-Xexpect-actual-classes")
        // The compiler prints a warning only when it recompiles that file, and
        // up-to-date or incremental builds never replay it, so warnings are easy
        // to miss. Fail the build instead.
        allWarningsAsErrors.set(true)
    }
    android {
        namespace = "com.faceclaw.shared"
        compileSdk = 35
        minSdk = 24
        compilerOptions { jvmTarget.set(JvmTarget.JVM_17) }
        withHostTestBuilder {}.configure {}
    }
    val framework = XCFramework("FaceclawKit")
    listOf(iosArm64(), iosSimulatorArm64()).forEach { target ->
        target.binaries.framework {
            baseName = "FaceclawKit"
            isStatic = true
            binaryOption("bundleId", "com.faceclaw.shared")
            framework.add(this)
        }
    }
}
