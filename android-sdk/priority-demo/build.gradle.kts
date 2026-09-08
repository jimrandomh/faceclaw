plugins { id("com.android.application") }

android {
 namespace = "com.faceclaw.demo"
 compileSdk = 35
 defaultConfig {
  applicationId = "com.faceclaw.demo"
  minSdk = 24
  targetSdk = 35
  versionCode = 1
  versionName = "0.1.0"
  testInstrumentationRunner = "com.faceclaw.demo.DemoSetup"
 }
 buildFeatures { buildConfig = true }
 flavorDimensions += "identity"
 productFlavors {
  create("alpha") {
   dimension = "identity"
   applicationIdSuffix = ".a"
   resValue("string", "app_name", "Faceclaw Demo A")
   buildConfigField("String", "DEMO_NAME", "\"Demo A\"")
   buildConfigField("boolean", "PROFILE_A", "true")
  }
  create("beta") {
   dimension = "identity"
   applicationIdSuffix = ".b"
   resValue("string", "app_name", "Faceclaw Demo B")
   buildConfigField("String", "DEMO_NAME", "\"Demo B\"")
   buildConfigField("boolean", "PROFILE_A", "false")
  }
 }
 compileOptions { sourceCompatibility = JavaVersion.VERSION_11; targetCompatibility = JavaVersion.VERSION_11 }
}
dependencies { implementation(project(":sdk")) }
