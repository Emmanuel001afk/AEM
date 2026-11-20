# AEM

## Multi-platform development status

See [implementation and verification ledger](docs/TRANSFORMATION.md), [download/install guide](docs/desktop/DOWNLOADS.md), [native source delivery](docs/native-delivery.md), and [resource policy / Latitude 3190](docs/host-requirements.md). This branch adds real delivery operations and automated tests but is **not a fully verified ecosystem release**. The ledger supersedes older feature-completeness claims below.

AEM is a personal software distribution store. It uses GitHub as its source provider, receives published APK artifacts, stores them in its own Supabase artifact storage, and distributes releases through the shared web + Android + Windows desktop clients.

Core pipeline: GitHub source -> published artifact -> AEM ingestion -> validation -> publication -> install/update.

The foundation is domain-first, provider-neutral, event-driven, storage-neutral, installer-aware, partner-aware, and designed for shared web + Android + desktop clients. GitHub is the first source provider. Android package identity, signing identity, and version code remain deterministic security boundaries; AI does not decide installation safety.

GitHub is the first source provider. Public repositories can be discovered without private credentials. Private repositories are accessed by the server-side `AEM_GITHUB_TOKEN` GitHub Actions secret; the token is never shipped to the Store client.

---

## Clients

| Client | Platform | Source | Build |
|---|---|---|---|
| **Web** | Browsers | `src/` + Vite | `npm run build` → `dist/` |
| **Android** | Android 7+ | `src/` + Capacitor + `native/` | `.github/workflows/aem-android-final.yml` → signed APK |
| **Windows Desktop** | Windows 10/11 x64 | `src/` + Electron + Android Emulator | `.github/workflows/aem-desktop.yml` → NSIS installer + portable |

Android and Windows are separate platform versions of AEM Store; see `docs/desktop/README.md` for install and `docs/emulator/README.md` for the integrated Android environment.

---

## Quick Start

### Web (local dev)

```bash
npm install
npm run dev            # http://localhost:5173
```

### Windows Desktop (local dev on any OS for UI preview)

```bash
npm install
npm run build          # renderer + electron main
npm run verify         # checks build, typecheck, artifacts
# On Windows for real installer:
npm run build:win      # release/AEM-Store-*-Setup-x64.exe
```

First desktop launch downloads the Android SDK (~1.1 GB) on demand — see `docs/emulator/README.md`.

### Android

```bash
npm run build:renderer   # or vite build --config vite.mobile.config.ts
npx cap add android
npx cap copy android
# Then open android/ in Android Studio or run gradle assembleRelease
```

CI builds are in `.github/workflows/`.

---

## GitHub source and release pipeline

AEM uses GitHub as the source-of-record provider for applications. The Store does not expose a manual source-build control: it consumes published release metadata and APK artifacts, validates package identity, signing identity, and version code, and then installs or updates from the single latest eligible release for the selected channel.

The Android Store APK itself is built by the repository's GitHub Actions release workflow. Its signed APK is published into AEM's Supabase artifact storage, where the catalog stores the durable release and artifact metadata used by the web and Android clients.

### Source-driven catalog
The Store catalog is provider-backed. GitHub is the current provider, with private/public repository discovery, APK-family artifact publication, durable AEM Storage copies, and server-side source credentials.

### Android client hardening
The Android wrapper uses the AEM launcher mark, Android package visibility limited to catalog package checks, a secure FileProvider for system installer handoff, and an AEM PackageInstaller session for APK-family packages.

Installer progress and cancellation are emitted by the native Android layer so the Store can show live file state instead of raw byte counters.

### AEM Transfer
AEM Transfer is the Store's direct, local-only file channel. Android ↔ Android uses Wi-Fi Direct: two phones build the link, the receiver explicitly accepts the request, and every file is SHA-256 verified before it is saved to `Downloads/AEM Transfer`. **PC ↔ PC** (`aem-peer/1`) pairs two AEM desktop installs with a one-use invitation, a 6-digit confirmation code shown on both screens, pinned identity certificates, HMAC-signed requests, per-chunk and whole-file SHA-256, exact resume offsets and quotas — see [`docs/pc-transfer.md`](docs/pc-transfer.md). A browser on any phone, tablet or second computer can pair with a PC through the separate `aem-lan/1` companion ([`docs/lan-transfer.md`](docs/lan-transfer.md)). Nothing is uploaded and no catalog row is written by any of the three.

PC pairing stores this device's identity key and the peer list in the app's user profile (`userData/aem-peer`) with owner-only permissions; unpairing deletes the key. Files received over any channel are never installed or executed by Transfer.

The screen uses the same visual language as the Store (red `#F04444` accent, radial dark backdrop, 20–22 dp cards, eyebrow labels) and is organised as **Transfer**, **Downloads** and **History**. A foreground service keeps receive sessions alive in the background.

Protocol version 6 adds receiver consent, a declared sender token, replay protection (a retried transfer id cannot create duplicates), path sanitisation, size/count bounds, resume from receiver offsets, and an honest decline path. See [`docs/transfer.md`](docs/transfer.md) for the wire format, permissions, storage layout, troubleshooting and the security model.

Final verification trigger: Android client and installer changes are built from the same main source tree.

---

## Windows Desktop & Emulator

**Objective:** AEM Store installable as native Windows desktop app with an integrated Android emulator for installing, running and testing APKs.

### Desktop Application Completeness

- **Identity:** `com.aem.store`, product “AEM Store”, proper icons, Start Menu & desktop shortcuts, file associations (`.apk/.apks/.xapk/.apkm`), `aem://` protocol, single-instance lock.
- **Startup:** Reliable Electron main process (`electron/main.ts`), window 1280×860, splash-free `ready-to-show`, crash handling, graceful emulator shutdown on quit.
- **File access:** Native file dialogs (`dialog.showOpenDialog`), drag-drop APK, open-external, show-in-folder, no browser sandbox limits.
- **Reproducible build:** `electron-builder` NSIS + portable, deterministic version stamp, CI-verified artifact size ≥10 MB, `npm run build:win` on `windows-latest`.
- **Architecture for other platforms:** main process uses `app.getPath` and CLI abstractions; `build.mac` and `build.linux` slots exist but are gated on `if: false` until Windows is green.

See [`docs/desktop/README.md`](docs/desktop/README.md) for install steps, build instructions and troubleshooting.

### Android Emulator Integration

- **Runtime chosen:** Official Android Emulator (AOSP, QEMU + WHPX/HAXM) — genuine Android, ADB-controllable, maintainable, Windows-compatible. Alternatives evaluated (WSA, Waydroid, proprietary LP) and rejected (discontinued, Linux-only, licensed). Download is on-demand (~1.1 GB) to satisfy SDK license.
- **Genuine environment:** System image `system-images;android-34;google_apis;x86_64` (Pixel 7 profile), API 34, `userdata-qemu.img` persistent, snapshot/cold-boot, host GPU (`-gpu auto`) with SwiftShader fallback.
- **APK install & launch:** `adb install` / `install-multiple` for split APKs, `monkey`/`am start` for launch, `pm` for permissions, push/pull for files. Tested with store catalog artifacts as “test APK”.
- **Storage / networking / permissions:** NAT networking, `/sdcard` storage, permission queries via `dumpsys package`, grant/revoke via `pm`.
- **Host integrations where supported:** clipboard, files, location (`geo fix`), rotation, screenshots, audio; camera emulated; Bluetooth/NFC correctly reported as unsupported.
- **Diagnostics:** `diagnostics.ts` checks virtualization (WMI/systeminfo), hypervisor (WHPX/Hyper-V/HAXM), RAM/disk/GPU/OS, with `Fix:` strings; `canRun` gates Start.
- **Resource management:** Local QEMU, configurable RAM/cores/storage/GPU, userData-based SDK/AVD paths, startup time 8–90s, logs in `userData/logs`.

See [`docs/emulator/README.md`](docs/emulator/README.md) for capabilities, quick start, performance and security.

### Store ↔ Emulator Integration

- AEM Store is the main app; emulator is a capability under **Emulator** tab (desktop-only, `isDesktop()`-gated).
- **Access:** Apps cards show **EMULATOR** button; detail page shows **INSTALL TO EMULATOR**; Emulator tab shows SDK status, AVD management, APK picker (file association + drag-drop), installed apps (launch/uninstall), logs, diagnostics, and host-integration matrix.
- **Separation:** Store never touches `adb`; emulator never touches Supabase except for artifact URLs Store provides. New code lives in `electron/emulator/` and `src/components/emulator/`.

### Acceptance Evidence

- `npm run build` → `dist/index.html` + `dist-electron/main.js`
- `npm run verify` → typecheck, vite build, electron compile, icon/docs presence
- `npm run verify:emulator` → manager exposes `installApk`, diagnostics, UI has Install/Launch/Diagnostics
- Windows artifact: `release/AEM-Store-*-Setup-x64.exe` (verified ≥10 MB in CI)
- Test APK: latest catalog artifact (e.g., `phormi-android`) installs via `emulator:installApkFromUrl` and appears in `getInstalledApps`, launches via `launchApp`.

---

## Host Requirements & Limitations

**Minimum:** Windows 10 2004+ x64, 4 GB RAM, 10 GB free, VT-x/AMD-V enabled, one of WHPX/Hyper-V/HAXM.

**Recommended:** 8 GB RAM, 20 GB free, 6+ cores, dedicated GPU.

Unsupported features, diagnostics and workarounds are documented in:

- [`docs/host-requirements.md`](docs/host-requirements.md) — single checklist
- [`docs/limitations.md`](docs/limitations.md) — source of truth for unsupported (Bluetooth/NFC/USB/Play/etc.)

---

## Project Structure

```
src/                    — shared React web UI (Home, Apps, Updates, Transfer, Settings, Emulator)
  App.tsx               — main router (nav gated on isDesktop())
  components/emulator/  — EmulatorView.tsx + emulator.css (desktop-integrated capability)
  components/transfer/  — DesktopTransfer.tsx channel switch + PeerTransfer.tsx (PC ↔ PC)
  services/
    catalog/            — Supabase + mock catalog
    emulator/           — contract.ts + desktop/mock bridges
    transfer/           — contract.ts for aem-lan/1 and aem-peer/1
electron/               — Windows desktop main process
  main.ts / preload.ts / ipc.ts / config.ts
  emulator/             — manager, sdk, avd, instance, adb, diagnostics (genuine Android)
  transfer/             — protocol.ts primitives, service.ts (aem-lan/1 browser), peer.ts (aem-peer/1 PCs)
resources/icons/        — app icons (ico/png/icns, file associations)
scripts/               — verify-build.mjs, verify-emulator.mjs
docs/
  desktop/README.md     — Windows install, build, startup, future platforms
  emulator/README.md    — runtime choice, capabilities, quick start, performance
  host-requirements.md  — checklist
  limitations.md        — unsupported features
.github/workflows/
  aem.yml               — web checks
  aem-desktop.yml       — Windows NSIS + verification (primary)
  aem-android-final.yml — Android signed APK
```

Verification is repeatable: `npm install && npm run build && npm run verify`.

