plugins {
    id("gie.spring-service")
}

dependencies {
    implementation(project(":platform:contracts"))
    implementation(libs.spring.boot.starter.webmvc)
    implementation(libs.spring.boot.starter.jdbc)
    implementation(libs.spring.boot.starter.flyway)
    implementation(libs.spring.boot.starter.kafka)
    implementation(libs.jackson.module.kotlin)
    runtimeOnly(libs.flyway.database.postgresql)
    runtimeOnly(libs.postgresql)

    testImplementation(libs.spring.boot.starter.test)
}
