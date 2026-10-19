plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

// The pinned certificate lives outside the repo (it carries the home's public
// IP); copy it into res/raw before every build so the APK trusts exactly it.
val opsCert = file(System.getProperty("user.home") + "/.career-ops-ops/cert.pem")
val copyOpsCert by tasks.registering(Copy::class) {
    from(opsCert)
    into("src/main/res/raw")
    rename { "ops_cert.pem" }
    doFirst { check(opsCert.exists()) { "missing $opsCert — generate the ops-api certificate first" } }
}
tasks.named("preBuild") { dependsOn(copyOpsCert) }

android {
    namespace = "com.craesol.cajitaops"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.craesol.cajitaops"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("debug")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { compose = true }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.12.01")
    implementation(composeBom)
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material:material-icons-core")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
}
