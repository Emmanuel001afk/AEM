# AEM Store — Implementation Plan

Branch: `arena/6f1f16e2-aem` (from `main` @ `89df759f4ff4e9893ae4660e1bdb89dd1224ed2e`)
Baseline verified: `npm install --ignore-scripts`, `npm run typecheck`, `npm run typecheck:electron`, `npm run build`, `npm run verify` all PASS on Linux.
Limitations of this sandbox: no Windows, no Android SDK/Gradle, no virtualization, no physical Android devices → Windows EXE, Android APK, emulator runtime, and phone↔PC transfer cannot be executed here. They are implemented/repaired at code+workflow level and verified where possible (typecheck/build/lint). Real-device validation is listed as remaining in PLAN.md section "Unverified".

## Progress (this branch)

- ✅ Stage 1 — Release workflow repair + emulator resource profiles: CODE COMPLETE & VERIFIED.
  - `aem-store-combined-release.yml`: `contents: write` + `publish-release` job (main push only) creating GitHub Release `v0.1.0-ci-${run_number}` with `app-release.apk`, Setup EXE, Portable EXE, `SHA256SUMS.txt`, `release-notes.md`. Validates deliverables before publishing.
  - `electron/emulator/resources.ts`: lightweight/balanced/standard host-aware profiles; `evaluateHost()`, `recommendProfile()`, `getResourceProfiles()`. Wired into manager/ipc/preload/contract + EmulatorView recommendation UI.
  - `npm run typecheck`, `typecheck:electron`, `build:renderer`, `build:electron`, `verify` all PASS.
- ✅ Stage 2 — Bidirectional phone↔PC transfer (desktop side): CODE COMPLETE (typecheck verified).
  - `electron/transfer/service.ts`: UDP beacon discovery, TCP data channel, pairing, SHA-256, offset resume, progress/cancel/pause/resume, session list.
  - `src/services/transfer/contract.ts`: shared TransferPeer/TransferFile/TransferSession/TransferBridge types.
  - IPC handlers (`transfer:discover|startReceiving|stop|send|listSessions|cancel|pause|resume|onProgress|offProgress`) + preload `transfer.*` bridge.
  - Runtime (UDP/TCP over LAN + physical phones) requires physical testing — NOT executable in this sandbox.
- ⬜ Stage 2.3 — Desktop Transfer UI (discover/pair/send/receive list) not yet built.
- ✅ Stage 3 — Unified execution-method selection: CODE COMPLETE & VERIFIED.
  - `src/domain/execution.ts`: ExecutionMethod (emulator/native-windows/phone-powered), CompatibilityAssessment, ExecutionDecision, assessExecution(). Native-windows uses assessNativeWindows (cannot-convert reporting); phone-powered uses assessPhonePowered (desktop-mode + authorization gating).
  - `src/services/execution/assessor.ts`: resolves host info from desktop bridge, assess per app.
  - `src/components/execution/ExecutionMethods.tsx`: availability chips + recommendation; integrated into AppCard (desktop) and app detail page (detailed).
  - `src/domain/nativeWindows.ts`: NativeWindowsVariant, cannot-convert reporting, no conversion promises.
  - `src/domain/phonePowered.ts`: PhoneSession/PhoneDevice model, desktop-mode + authorization gating.
  - `src/services/phone-powered/contract.ts`: PhoneBridge IPC scaffolding (discover/authorize/start/end session).
  - typecheck + verify PASS.
- ✅ Stage 4 — Native Windows delivery framework: CODE COMPLETE & VERIFIED.
  - Native build strategy model (source-rebuild / wrapper / unavailable), cannot-convert reasons for apps without Windows artifacts.
- ✅ Stage 5 — Phone-powered desktop execution: CODE COMPLETE (scaffolding, typecheck verified).
  - Domain model + assessment + PhoneBridge contract; runtime mirroring/control requires physical devices + ADB.
- ✅ Stage 6 — Cross-platform recognition: CODE COMPLETE & VERIFIED.
  - `src/domain/crossPlatform.ts`: RecognizablePlatforms (AEM Store, EMA, OEA, Phormi, Central Hub), ConnectedApp, RecognitionRequest/Response, mergeRecognition (union, no identity/DB merges).

## Remaining (requires physical testing — not executable in this sandbox)

## Audit findings

### Preserved (working, keep intact)
- Android app `com.aem.store` (Capacitor + Compose, minSdk 26 / targetSdk 35): catalog, APK download/install via PackageInstaller + system installer, split APKs (APKS/XAPK/APKM), signing-certificate verification, updates, Wi-Fi Direct transfer (phone↔phone, protocol v6, SHA-256, resume), settings, foreground transfer service.
- `native/` sources copied into Capacitor project by CI (`aem-android-final.yml`): AemInstallerPlugin, AemTransferPlugin/Service/Activity, MainActivity, InstallConfirmationActivity, InstallResultReceiver, patch_android_manifest.py.
- Windows desktop (Electron): catalog, emulator integration (SDK download, AVD, ADB install/launch/lifecycle), file associations (.apk/.apks/.xapk/.apkm/.zip), `aem://` protocol, single instance, Start Menu/desktop shortcuts (NSIS), icon, update check via GitHub API.
- Emulator (`electron/emulator/`): sdk.ts, avd.ts, instance.ts, adb.ts, diagnostics.ts, manager.ts; UI `src/components/emulator/EmulatorView.tsx`.
- CI: `aem.yml`, `aem-desktop-check.yml`, `aem-desktop.yml` (NSIS + portable), `aem-android-final.yml` (signed APK), central-signing workflows, `aem-store-combined-release.yml`, `aem-store-self-publish-v2.yml`.
- Supabase: catalog, downloads, notifications, release history, migrations, edge functions.

### Defects found
1. **No GitHub Release is ever created.** `aem-store-combined-release.yml` only uploads a workflow artifact (`aem-store-complete-release`, expires after 30 days) and has `permissions: contents: read`. Users cannot discover/download the APK, Setup EXE, or Portable EXE from GitHub Releases — this is the root cause of the "open ZIP with WinRAR" workflow. **Must fix: create a GitHub Release with clearly named APK + Setup EXE + Portable EXE + checksums.**
2. **Emulator resources are not host-aware.** `ensureDefaultAvd()` hardcodes 3072 MB RAM / 4 cores / 8 GB storage for every host. On a 4 GB RAM Dell Latitude 3190 this oversubscscribes Windows. No lightweight/balanced/standard profiles, no auto-recommendation, no UI exposure.
3. **Desktop Transfer tab is phone-only explainer.** No phone→PC or PC→phone transfer (requirement 7: both directions mandatory).
4. **No unified execution-method selection.** No compatibility assessment/recommendation across emulator / native Windows / phone-powered (requirement 5.4).
5. **No native Windows delivery framework.** No Windows app variant model (EXE/MSIX artifacts), no "cannot convert" identification for apps without source (requirements 5, 6).
6. **No cross-platform recognition interfaces** for AEM Store / EMA / OEA / Phormi / Central Hub on the AEM side (requirement 8).
7. Test fixture `test-fixtures/test.apk` is a ZIP placeholder, not a valid signed APK (documented).

## Stage 1 — Release workflow repair + emulator resource profiles (verifiable here)
1.1 `aem-store-combined-release.yml`: `contents: write`; add `publish-release` job (main only, after verify-and-package) that creates a GitHub Release via `gh release create` with a unique tag (`v0.1.0-ci-${run_number}`), uploads `app-release.apk`, `AEM-Store-*-Setup-x64.exe`, `AEM-Store-*-Portable-x64.exe`, `SHA256SUMS.txt`, clear body describing each file; do not publish if any deliverable missing.
1.2 Keep self-publish-v2 (Supabase Android publication) unchanged; it is the Android publication route, separate from the GitHub Release downloads.
1.3 Emulator host-resource profiles: new `electron/emulator/resources.ts` computing lightweight/balanced/standard from total/free RAM, cores, disk, virtualization; `recommendConfiguration()`; wire into EmulatorManager (`getResourceProfiles`, `recommendConfiguration`), IPC (`emulator:getResourceProfiles`, `emulator:recommendConfiguration`), preload, contract; `ensureDefaultAvd` uses the recommended profile; EmulatorView shows recommendation + pre-fills AVD creation form.
1.4 Run typecheck + verify.

## Stage 2 — Bidirectional phone↔PC transfer (desktop side)
2.1 Electron transfer service: local discovery (UDP beacon, no native deps), TCP transfer server, pairing tokens, SHA-256 integrity, resume from offsets, progress, cancel, incoming queue.
2.2 IPC contract + preload exposure + types.
2.3 Desktop Transfer UI: discover/pair, send files to phone, receive files from phone, transfer list, integrity verification, resume.
2.4 Typecheck + verify.

## Stage 3 — Unified execution-method selection
3.1 Domain: `ExecutionMethod` (emulator | native-windows | phone-powered), `CompatibilityAssessment`, `ExecutionDecision`.
3.2 Service: assess per catalog app (emulator compatible if APK artifact exists + host can run emulator; native-windows if Windows artifact exists; phone-powered if phone-compatible flag); recommend; explain unavailability.
3.3 UI: app cards/detail show available methods with reasons, manual selection + auto-recommendation toggle.
3.4 Typecheck + verify.

## Stage 4 — Native Windows delivery framework
4.1 Model: `platforms` includes "windows"; artifact kind `exe`/`msix`; `nativeWindows` variant info (build strategy, source availability, identity mapping).
4.2 "Cannot convert" reporting for apps without source/components; no conversion promises.
4.3 Typecheck + verify.

## Stage 5 — Phone-powered desktop execution (investigation + framework)
5.1 Documented investigation: native desktop modes (Samsung DeX etc.) not controllable by AEM; AEM-managed alternative via ADB + screen mirroring (scrcpy-like) over the phone's adb connection.
5.2 IPC/contract scaffolding for phone session (discover phone via adb, mirror, control), gated behind authorization.
5.3 Typecheck + verify.

## Stage 6 — Cross-platform recognition (AEM side only)
6.1 Registration/discovery interfaces for AEM Store, EMA, OEA, Phormi, Central Hub: identity, capabilities, authorized requests, version awareness; separate DB boundaries preserved; no changes to other repositories.
6.2 Typecheck + verify.

## Stage 7 — Regression + docs
7.1 Re-run typecheck/build/verify; docs updated (docs/desktop, docs/emulator, docs/transfer, PLAN).
7.2 Final evidence-based report.

## Environment constraints (honest)
- Windows EXE / Android APK builds, emulator runtime, and phone↔PC transfer runtime tests REQUIRE Windows + Android SDK + physical devices; absent here. Marked "requires physical testing".