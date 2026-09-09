plugins { id("com.android.application") }

android {
    namespace = "com.faceclaw.starter"
    compileSdk = 35
    defaultConfig {
        applicationId = "com.faceclaw.starter"
        minSdk = 24
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
}

dependencies {
    implementation("com.faceclaw:sdk:0.3.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}
