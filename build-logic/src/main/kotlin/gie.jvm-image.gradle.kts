plugins {
    id("com.google.cloud.tools.jib")
}

jib {
    from {
        image = "eclipse-temurin:25-jre"
    }
    to {
        image = "game-item-exchange/${project.name}:dev"
    }
    container {
        user = "1000:1000"
        jvmFlags = listOf(
            "-XX:MaxRAMPercentage=75",
            "-XX:+UseSerialGC",
            "-XX:+UseCompactObjectHeaders",
            "-XX:+ExitOnOutOfMemoryError",
        )
    }
}
