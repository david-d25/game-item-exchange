plugins {
    `kotlin-dsl`
}

dependencies {
    implementation(libs.kotlin.gradle.plugin)
    implementation(libs.kotlin.serialization.gradle.plugin)
    implementation(libs.spring.boot.gradle.plugin)
    implementation(libs.kotlin.allopen.gradle.plugin)
}
