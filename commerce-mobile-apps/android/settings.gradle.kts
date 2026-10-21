pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "RocentoMobile"

include(":app", ":core")
// Standalone is the default: the builder is absent from the dependency graph.
if (providers.gradleProperty("appBuilder").orNull == "true") include(":app-builder")
