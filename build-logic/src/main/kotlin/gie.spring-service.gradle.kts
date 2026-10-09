import org.jetbrains.kotlin.gradle.plugin.getKotlinPluginVersion
import org.springframework.boot.gradle.plugin.SpringBootPlugin

plugins {
    id("gie.kotlin-library")
    kotlin("plugin.spring")
    id("org.springframework.boot")
}

dependencies {
    implementation(platform(SpringBootPlugin.BOM_COORDINATES))
    // Spring Boot's BOM pins an older Kotlin; align every Kotlin artifact, kotlin-reflect included, with the compiler
    implementation(platform("org.jetbrains.kotlin:kotlin-bom:${getKotlinPluginVersion()}"))
    implementation("org.jetbrains.kotlin:kotlin-reflect")
}
