plugins {
    id("com.google.cloud.tools.jib")
}

// Locally the images are game-item-exchange/<project>:dev, loaded into Docker by jibDockerBuild.
// CI pushes to a registry instead: -PimageRepository=ghcr.io/<owner>/<repo> -PimageTag=<commit>
val imageRepository = providers.gradleProperty("imageRepository").getOrElse("game-item-exchange")
val imageTag = providers.gradleProperty("imageTag").getOrElse("dev")

jib {
    from {
        image = "eclipse-temurin:25-jre"
    }
    to {
        image = "$imageRepository/${project.name}:$imageTag"
    }
    container {
        user = "1000:1000"
        // The source links the image to the repository on GHCR. The others replace the labels
        // inherited from the Ubuntu base image, which GHCR would show as this image's description.
        labels.set(
            mapOf(
                "org.opencontainers.image.source" to "https://github.com/david-d25/game-item-exchange",
                "org.opencontainers.image.title" to "game-item-exchange/${project.name}",
                "org.opencontainers.image.description" to "Game Item Exchange: ${project.name}",
                "org.opencontainers.image.version" to imageTag,
            )
        )
        jvmFlags = listOf(
            "-XX:MaxRAMPercentage=75",
            "-XX:+UseSerialGC",
            "-XX:+UseCompactObjectHeaders",
            "-XX:+ExitOnOutOfMemoryError",
        )
    }
}
