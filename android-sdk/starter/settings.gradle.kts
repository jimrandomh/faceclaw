pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }
val bundledSdkRepository = rootDir.resolve("sdk-repository").takeIf { it.isDirectory }
    ?: rootDir.parentFile.resolve("sdk-repository")
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google(); mavenCentral()
        exclusiveContent {
            forRepository { maven { url = uri(bundledSdkRepository) } }
            filter { includeGroup("com.faceclaw") }
        }
    }
}
rootProject.name = "faceclaw-apk-starter"
include(":app")
