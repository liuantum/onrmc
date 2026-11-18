import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
}

// Release signing: keystore.properties next to this file (local builds) or ONRMC_KEYSTORE_* environment variables (CI).
val keyProps = Properties().apply {
    val f = rootProject.file("keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}
fun signingValue(key: String, env: String): String? = keyProps.getProperty(key) ?: System.getenv(env)

android {
    namespace = "com.onrmc.owner"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.onrmc.owner"
        minSdk = 26
        targetSdk = 36
        versionCode = (project.findProperty("onrmc.versionCode") as String?)?.toInt() ?: 1
        versionName = (project.findProperty("onrmc.versionName") as String?) ?: "1.0.0"
    }

    signingConfigs {
        create("release") {
            val store = signingValue("storeFile", "ONRMC_KEYSTORE_FILE")
            if (store != null) {
                storeFile = rootProject.file(store)
                storePassword = signingValue("storePassword", "ONRMC_KEYSTORE_PASSWORD")
                keyAlias = signingValue("keyAlias", "ONRMC_KEY_ALIAS")
                keyPassword = signingValue("keyPassword", "ONRMC_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
            // Plain http is allowed only in debug builds, for a laptop server on Wi-Fi.
            manifestPlaceholders["cleartext"] = "true"
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            manifestPlaceholders["cleartext"] = (project.findProperty("onrmc.allowHttp") as String?) ?: "false"
            if (signingValue("storeFile", "ONRMC_KEYSTORE_FILE") != null) signingConfig = signingConfigs.getByName("release")
        }
    }

    buildFeatures { compose = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }

dependencies {
    implementation(project(":core"))
    implementation(libs.osmdroid)
}
