buildscript {
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        classpath("com.android.tools.build:gradle:8.2.2")
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:1.9.22")
    }
}

allprojects {
    repositories {
        google()
        mavenCentral()
    }
} // ★ nodejs-mobile（内置 Node 运行时）通过 JitPack 分发，必须加入仓库列表
        maven { url = uri("https://www.jitpack.io") }
    }
}