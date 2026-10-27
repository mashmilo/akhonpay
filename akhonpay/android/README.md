# Akhonpay Forwarder (Android)

Reads incoming bKash / Nagad / Rocket payment SMS on the phone that holds your SIM and forwards
them, signed, to your Akhonpay server.

## Build without installing anything (free)
1. Push the repo to GitHub.
2. **Actions → Build Android APK → Run workflow** (it also runs on every push that touches `android/`).
3. Download the `akhonpay-forwarder-apk` artifact, unzip, copy the `.apk` to the phone and install it.

## Build with Android Studio
Open the `android/` folder. Studio will offer to create the Gradle wrapper (Gradle 8.9). Run ▶ or
**Build → Build APK(s)**.

## Optional: your own signing key
```bash
keytool -genkeypair -v -keystore akhonpay.jks -alias akhonpay -keyalg RSA -keysize 2048 -validity 10000
base64 -w0 akhonpay.jks     # paste as the secret AKHONPAY_KEYSTORE_B64
```
Add repo secrets `AKHONPAY_KEYSTORE_B64`, `AKHONPAY_KEYSTORE_PASSWORD`, `AKHONPAY_KEY_ALIAS`,
`AKHONPAY_KEY_PASSWORD`. Keep the same key for every future update, otherwise Android will refuse to
update over the old install.

## First run on the phone
Android 13+ blocks SMS permission for sideloaded apps until you do:
**Settings → Apps → Akhonpay Forwarder → ⋮ → Allow restricted settings**, then grant SMS permission
and set battery to **Unrestricted**.

## Layout
- `app/src/main/AndroidManifest.xml` – permissions, `SmsReceiver` (protected by `BROADCAST_SMS`)
- `app/src/main/res/` – layout, theme, strings, adaptive + legacy icons from the Akhonpay logo
- `app/src/main/java/com/akhonpay/forwarder/` – Kotlin sources (next step)

## Source files (step 2)
`SmsReceiver` (checks real OriginatingAddress) → `SmsParser` (regex) → `UploadWorker` (WorkManager, retries) →
`Http` (HMAC-SHA256 signed POST to `/api/v1/mfs-callback`). `Config` = encrypted settings, `ActivityLog` = last 30 events,
`MainActivity` = status, settings, **Test server connection** (signed request with a fake sender; "OK" = HTTP 422, nothing is stored),
and the **Parse sample** box. Unit tests: `app/src/test/.../SmsParserTest.kt` (run automatically by the CI workflow).
