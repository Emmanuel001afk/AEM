# Limitations & Unsupported Features

_Last updated: 2025-10-30 — AEM Store 0.1.0 desktop with Android Emulator_

This document is the source of truth for what the emulator **cannot** do, so QA and users are not surprised. It is updated with each release.

## Emulator — Not Supported

| Feature | Why | Workaround |
|---|---|---|
| Bluetooth, NFC, physical USB passthrough | QEMU does not expose these to Android | Test on physical phone via AEM Transfer + real install |
| Telephony (SIM, calls), real SMS | No modem; `emu sms send` is fake | Use Firebase Auth test numbers |
| Biometrics (fingerprint/face) hardware | Emulator has stub UI only | Mock via `adb shell cmd biometric` in automation |
| Widevine L1 DRM, hardware attestation | Requires secure hardware | L3 works for non-DRM; use real device for DRM QA |
| ARM-native NDK libs on x86 AVD (some fail) | ARM→x86 translation is best-effort | Provide x86_64 APK variant when possible |
| Google Play on default AVD | Default image is `google_apis` (no Play) | Create AVD with `google_apis_playstore` image, sign in |
| Background long-running services when host sleeps | Host sleep pauses QEMU | Disable sleep during long tests |

## Desktop — Known Gaps

| Gap | Impact | Plan |
|---|---|---|
| No EV code signing | SmartScreen warning on first install | Will add after first stable; for now user clicks “More info” |
| Emulator window is separate (not embedded) | Two windows (Store + Emulator) | Future: embed via WebView or scrcpy streaming |
| No silent auto-update | User must download new installer | Will add `electron-updater` with differential downloads |
| No offline SDK bundle | First SDK download needs internet (~1.1 GB) | Future offline installer option |
| Single AVD at a time | Only one emulator concurrently | Multi-AVD is not a priority; can be added via `-ports` |

## Store — Unchanged Constraints

- Catalog is provider-backed (GitHub → Supabase). No manual APK upload in Store UI; use GitHub release + ingestion.
- Signing identity remains deterministic security boundary (AI never decides safety). Store refuses install if signing cert mismatches.
- Transfer stays Android-to-Android Wi-Fi Direct; desktop shows explainer only.

## When to Use Physical Device Instead

- BLE/NFC/USB hardware, real network handoff (cellular), camera QA requiring real sensor, DRM, performance benchmarking on target SoC.
