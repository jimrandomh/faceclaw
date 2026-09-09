plugins { id("com.android.application") }
android {
 namespace = "com.faceclaw.sdk.hosttest"
 compileSdk = 35
 defaultConfig { applicationId = "com.faceclaw.sdk.hosttest"; minSdk = 24; targetSdk = 35; testInstrumentationRunner = "com.faceclaw.sdk.hosttest.BoundaryTest" }
 flavorDimensions += "host"
 productFlavors {
  create("standalone") { dimension = "host" }
  create("upstream") { dimension = "host"; applicationId = "com.faceclaw.app" }
  create("t3") { dimension = "host"; applicationId = "com.deejanuz.faceclaw.t3" }
 }
 compileOptions { sourceCompatibility = JavaVersion.VERSION_11; targetCompatibility = JavaVersion.VERSION_11 }
 sourceSets["main"].java.srcDir(layout.buildDirectory.dir("generated/host"))
}
dependencies { implementation(project(":sdk")) }

val copyHostSources by tasks.registering(Sync::class) {
 from(rootProject.file("../App_Resources/Android/src/main/java")) { include("com/faceclaw/app/FaceclawExternalApps.java", "com/faceclaw/app/FaceclawExtensions.java", "com/faceclaw/app/ExtensionSnapshotBudget.java", "com/faceclaw/app/FaceclawSettings.java", "com/faceclaw/app/FaceclawSettingsListener.java", "com/faceclaw/app/FaceclawExternalAppListener.java", "com/faceclaw/app/FaceclawAppSettingsActivity.java") }
 into(layout.buildDirectory.dir("generated/host"))
}
tasks.named("preBuild") { dependsOn(copyHostSources) }
