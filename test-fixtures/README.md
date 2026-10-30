# Test APK for Emulator Acceptance

The emulator acceptance criterion requires a test APK that can be installed and launched in the genuine Android environment.

## Primary Test Source

**Catalog artifact**: Any ready APK from the AEM Supabase catalog (e.g., `phormi-android` or `lite-read`) serves as the test APK. The store's own release pipeline publishes these as `artifacts` with `signing_status=ready`. They are genuine, signed APKs and can be fetched via `download_url`.

The desktop app's **Emulator → Install APK File…** or **Apps → EMULATOR** button downloads the artifact to a temp file and runs `adb install`.

Verification in CI without a real emulator uses the mock emulator (`src/services/emulator/mock.ts`), which simulates the install and records the package.

## Local Test APK

A minimal dummy APK is provided for offline pipeline tests:

- `test-fixtures/test.apk` — a ZIP-format placeholder (not a valid signed APK). The mock emulator accepts it; a real emulator would reject it with `INSTALL_FAILED_INVALID_APK`. For real-device validation, always use a catalog artifact or a locally built APK.

To build a valid test APK locally:

```bash
# Using Android SDK (requires SDK + Gradle)
./gradlew :app:assembleDebug
# Or download a known good APK:
curl -L -o test-fixtures/real-test.apk "https://github.com/patrickfav/uber-apk-signer/releases/download/v1.3.0/uber-apk-signer-1.3.0.jar"
# (Example — replace with a real APK URL)
```

## Verification Script

```bash
npm run verify:emulator
node scripts/test-emulator-install.mjs
```

The script exercises `installApk`, `getInstalledApps`, and `launchApp` via the mock, proving the integration wiring.
