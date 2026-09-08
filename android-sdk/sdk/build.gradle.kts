plugins { id("com.android.library") }
group = "com.faceclaw"
version = "0.1.0"
android {
 namespace = "com.faceclaw.sdk"
 compileSdk = 35
 defaultConfig { minSdk = 24; consumerProguardFiles("consumer-rules.pro") }
 compileOptions { sourceCompatibility = JavaVersion.VERSION_11; targetCompatibility = JavaVersion.VERSION_11 }
 testOptions { unitTests.isReturnDefaultValues = true }
}
dependencies { testImplementation("junit:junit:4.13.2") }
