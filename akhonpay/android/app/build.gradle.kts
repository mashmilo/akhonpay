plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.akhonpay.forwarder"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.akhonpay.forwarder"
        minSdk = 24            // EncryptedSharedPreferences needs 23+; 24 covers ~99% of phones in use
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"
    }

    // Release signing is optional. If these environment variables are present (e.g. GitHub Actions
    // secrets) the APK is signed with your own key; otherwise it falls back to the debug key,
    // which is fine for installing on your own phone.
    val ksFile = System.getenv("AKHONPAY_KEYSTORE_FILE")
    signingConfigs {
        if (!ksFile.isNullOrBlank() && file(ksFile).exists()) {
            create("release") {
                storeFile = file(ksFile)
                storePassword = System.getenv("AKHONPAY_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("AKHONPAY_KEY_ALIAS")
                keyPassword = System.getenv("AKHONPAY_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false   // keeps Tink/security-crypto safe; the app is tiny anyway
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }

    buildFeatures { buildConfig = true }

    // Only .kt unit tests of pure logic (SmsParser) live in src/test; nothing needs a device.
    testOptions { unitTests.isReturnDefaultValues = true }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.work:work-runtime-ktx:2.9.1")
    implementation("androidx.security:security-crypto:1.1.0-alpha06")

    testImplementation("junit:junit:4.13.2")
}
