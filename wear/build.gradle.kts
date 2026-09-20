// Faceclaw watch app (Wear OS companion). A standalone Gradle project: it
// shares nothing with the NativeScript build except the applicationId and
// (for release builds) the signing key, both of which the Wearable Data
// Layer requires to match the phone app.
plugins {
    id("com.android.application") version "8.7.3" apply false
    id("org.jetbrains.kotlin.android") version "2.1.10" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.1.10" apply false
}
