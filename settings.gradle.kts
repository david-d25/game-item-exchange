pluginManagement {
    includeBuild("build-logic")
}

plugins {
    // Downloads the JDK requested by jvmToolchain() if it is not installed locally
    id("org.gradle.toolchains.foojay-resolver-convention") version "1.0.0"
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        mavenCentral()
    }
}

rootProject.name = "game-item-exchange"

include(":platform:contracts")
include(":platform:core")
include(":platform:matcher")
