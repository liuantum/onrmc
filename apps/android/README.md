# onrmc Android apps (native Kotlin)

Two native Android apps built with Kotlin and Jetpack Compose, sharing one `core` module:

| Module | App | Who signs in | What it does |
|---|---|---|---|
| `driver` | **onrmc Driver** (`com.onrmc.driver`) | DRIVER | Today's trips, one-tap trip steps (loaded → in transit → at site → unloading → delivered → back at plant), receiver name and diesel on delivery, navigate / call site, and live GPS through a foreground service |
| `owner` | **onrmc Owner** (`com.onrmc.owner`) | OWNER | Today's production, deliveries, billing and collections, receivables, private monthly margin, trucks on the road on a map, alerts for overdue truck services and due cube tests, subscription warnings |
| `core` | library | | API client, sign-in screen, theme, shared UI |

Requirements: Android 8.0 (API 26) or newer. Built against API 36.

## GPS tracking (driver app)

- Starts when the driver taps **Loaded at plant** or **Start trip**, and stops at **Back at plant**.
- Runs as an Android foreground service of type *location* with a permanent "Trip in progress" notification,
  so it keeps working with the screen off and the app in the background.
- One fix every ~15 s (or every 25 m), using Google Play services' fused location. Fixes worse than 100 m are skipped.
- Points are first saved on the phone (up to 20,000) and sent every 20 s in batches of 500. In a network dead zone
  nothing is lost; the backlog is sent when the signal returns.
- After a phone restart or an app update, tracking resumes by itself if a trip was in progress.
- Permissions asked: precise location, then **Allow all the time** (Android 10+), then notifications (Android 13+).
  If "all the time" is refused, tracking still works while the app is open and the trip banner offers a shortcut
  to the setting.
- Tip for drivers: on some phones (Xiaomi, Oppo, Vivo, Realme) also set the app's battery mode to "No restrictions".

## Get the APKs

**From GitHub (no setup):** every push that touches `apps/android/` runs the *Android apps* workflow. Open the run
in the repository's **Actions** tab and download **onrmc-android-debug** (both APKs). Copy an APK to the phone and
open it (allow "install unknown apps" once).

To bake in your server address, run the workflow by hand (**Run workflow**) and fill in *api_url*,
e.g. `https://api.yourdomain.in/api`. The address can always be changed on the sign-in screen
(tap the "Server: …" line under the Sign in button).

**On your Mac with Android Studio:** open the `apps/android` folder, let Gradle sync, pick `driver` or `owner`
and press Run with the phone connected by USB (developer mode + USB debugging on).

Command line (needs JDK 17+ and the Android SDK, e.g. from Android Studio):

```bash
cd apps/android
./gradlew :driver:assembleDebug :owner:assembleDebug
# APKs: driver/build/outputs/apk/debug/driver-debug.apk, owner/build/outputs/apk/debug/owner-debug.apk
```

## Pointing the apps at your server

- **Emulator:** the default `http://10.0.2.2:4000/api` is your computer.
- **Phone on the same Wi-Fi as your computer (debug build):** on the sign-in screen tap the server line and enter
  your computer's Wi-Fi IP, e.g. `192.168.1.20` (it becomes `http://192.168.1.20:4000/api`). Run the API with
  `pnpm dev:api`; it listens on all interfaces.
- **Production:** use an `https://` address. Release builds refuse plain `http://` (Android's cleartext rule) unless
  built with `-Ponrmc.allowHttp=true`, which is not recommended.

## Release builds for the Play Store

1. Create an upload key once (keep it safe; you need the same key for every update):
   `keytool -genkeypair -v -keystore onrmc-release.jks -alias onrmc -keyalg RSA -keysize 4096 -validity 10000`
2. Either create `apps/android/keystore.properties` (git-ignored):
   ```
   storeFile=onrmc-release.jks
   storePassword=...
   keyAlias=onrmc
   keyPassword=...
   ```
   and run `./gradlew :driver:bundleRelease :owner:bundleRelease -Ponrmc.apiUrl=https://api.yourdomain.in/api`,
   or add GitHub secrets `ONRMC_KEYSTORE_BASE64` (`base64 -i onrmc-release.jks`), `ONRMC_KEYSTORE_PASSWORD`,
   `ONRMC_KEY_ALIAS`, `ONRMC_KEY_PASSWORD`, and the workflow also produces signed APKs and `.aab` bundles
   (**onrmc-android-release**).
3. Play Console: the driver app uses background location, so fill in the *Location permissions* declaration
   (core feature: "share the delivery truck's live location with the plant's dispatch during an active trip") and
   add a short video of the trip flow. The foreground-service declaration is *Location*.

Version: `-Ponrmc.versionCode=N -Ponrmc.versionName=1.2.0` (CI uses the run number as the version code).
