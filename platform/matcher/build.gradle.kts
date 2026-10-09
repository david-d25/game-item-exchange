plugins {
    id("gie.kotlin-library")
    application
}

dependencies {
    implementation(project(":platform:contracts"))
    // Only for versions shared with core; there is no Spring in the matcher
    implementation(platform(libs.spring.boot.bom))
    implementation(libs.kafka.clients)
    implementation(libs.slf4j.api)
    runtimeOnly(libs.logback.classic)
}

application {
    mainClass.set("space.davids_digital.giexchange.matcher.MatcherAppKt")
}
