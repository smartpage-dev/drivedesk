plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Release signing is optional: set these env vars (CI secrets) to produce an updatable, signed APK.
val keystorePath: String? = System.getenv("ANDROID_KEYSTORE_PATH")

android {
    namespace = "app.drivedesk.phone"
    compileSdk = 35

    defaultConfig {
        applicationId = "app.drivedesk.phone"
        minSdk = 26          // Android 8.0+
        targetSdk = 35
        versionCode = 2
        versionName = "0.3.0"
    }

    signingConfigs {
        if (keystorePath != null) {
            create("release") {
                storeFile = file(keystorePath)
                storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("ANDROID_KEY_ALIAS")
                keyPassword = System.getenv("ANDROID_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            if (keystorePath != null) signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}
