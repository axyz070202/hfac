plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.hfac.calls"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.hfac.calls"
        minSdk = 26
        targetSdk = 35
        versionCode = 5
        versionName = "0.5.0"

        // Baked-in signaling server. Supplied at build time via the
        // HFAC_SERVER_URL Gradle property (CI sets ORG_GRADLE_PROJECT_HFAC_SERVER_URL
        // from a repo variable). Empty -> the app shows the manual server field.
        val defaultServerUrl = (project.findProperty("HFAC_SERVER_URL") as String?)
            ?: System.getenv("HFAC_SERVER_URL") ?: ""
        buildConfigField("String", "DEFAULT_SERVER_URL", "\"$defaultServerUrl\"")
    }

    buildFeatures {
        buildConfig = true
    }

    // Release signing comes from the environment (CI decodes the keystore from
    // a secret; locally, source android/keystore/KEYSTORE_CREDENTIALS.local.txt).
    // Without the env vars the release build simply stays unsigned.
    val keystorePath = System.getenv("KEYSTORE_PATH")
    if (keystorePath != null) {
        signingConfigs {
            create("release") {
                storeFile = file(keystorePath)
                storePassword = System.getenv("KEYSTORE_PASSWORD")
                keyAlias = System.getenv("KEY_ALIAS")
                keyPassword = System.getenv("KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (keystorePath != null) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    // Prebuilt libwebrtc (org.webrtc.*), maintained builds of upstream WebRTC.
    implementation("io.github.webrtc-sdk:android:125.6422.07")

    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")

    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")

    // QR: zxing core for generating, embedded for the scan activity.
    implementation("com.google.zxing:core:3.5.3")
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
}
