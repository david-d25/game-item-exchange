plugins {
    id("gie.kotlin-serialization")
}

dependencies {
    // api, not implementation: ContractsJson exposes kotlinx.serialization's Json to consumers
    api(libs.kotlinx.serialization.json)
}
