plugins {
    id("com.android.library")
    id("maven-publish")
}
group = "com.faceclaw"
version = "0.2.0"
android {
 namespace = "com.faceclaw.sdk"
 compileSdk = 35
 defaultConfig { minSdk = 24; consumerProguardFiles("consumer-rules.pro") }
 compileOptions { sourceCompatibility = JavaVersion.VERSION_11; targetCompatibility = JavaVersion.VERSION_11 }
 testOptions { unitTests.isReturnDefaultValues = true }
 publishing { singleVariant("release") { withSourcesJar() } }
}
dependencies { testImplementation("junit:junit:4.13.2") }

val portableRepositoryDir = providers.gradleProperty("portableRepositoryDir")
    .map { file(it) }
    .orElse(layout.buildDirectory.dir("portable-repository").map { it.asFile })

publishing {
    repositories {
        maven {
            name = "portableRepository"
            url = uri(portableRepositoryDir.get())
        }
    }
    publications {
        register<MavenPublication>("release") {
            afterEvaluate { from(components["release"]) }
            pom {
                name.set("Faceclaw Android SDK")
                description.set("Android application SDK for Faceclaw hosts")
                url.set("https://github.com/jimrandomh/faceclaw")
                licenses { license { name.set("GNU General Public License, version 3"); url.set("https://www.gnu.org/licenses/gpl-3.0.html") } }
            }
        }
    }
}
