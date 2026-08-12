pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
        // nodejs-mobile：内置 Node.js 运行时（在 App 内跑网易云 API）
        maven { url = uri("https://www.jitpack.io") }
    }
}
rootProject.name = "StoryPhone"
include(":app")
