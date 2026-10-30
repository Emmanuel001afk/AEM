# AEM Store — Integrated Android Emulator

The desktop app embeds a **genuine Android environment** — not a compatibility layer — capable of installing, running, and testing APKs locally on Windows.

## Technology Choice

### Selected Runtime: Android SDK Emulator (Google)

AEM Store integrates the **official Android Emulator** from the Android SDK. Rationale:

| Criterion | Android SDK Emulator | Alternatives (WSA, Waydroid, LDPlayer, etc.) |
|---|---|---|
| Genuine Android | ✅ Yes — AOSP + Google APIs, API 34 default | WSA: discontinued & closed; third-party: forked & licensed |
| APK install/launch | ✅ `adb install`, `am start`, `pm` | All support, but third-party often wrap/custom |
| Licensing | ✅ SDK license (redistribute via on-demand download) | LDPlayer/Nox: proprietary EULAs prohibit bundling |
| Maintainability | ✅ Google-maintained, docs, community | WSA: EOL 2025; Waydroid: Linux-only; others close-sourced |
| Windows compatibility | ✅ WHPX/HAXM/Hyper-V, host GPU | Good, but varying driver needs |
| Performance | ✅ QEMU+accel, snapshots, cold boot | Similar, but less predictable |

**Decision:** Use Android SDK Emulator. It is the only open, maintained, cross-platform, genuinely Android runtime with full ADB control. AEM Store downloads it on first use (~1.1 GB) rather than bundling, satisfying the SDK license and keeping the installer small.

Alternatives considered and rejected are documented to show due diligence; the architecture remains pluggable if a future runtime (e.g., a new WSA successor) becomes viable.

## What It Can Do

- **APK formats:** `.apk`, `.apks` (bundletool), `.xapk`, `.apkm`, `.zip` (containing APKs) — via `adb install` / `install-multiple`.
- **App lifecycle:** Install, update (`-r`), downgrade (`-d`), launch (`monkey`/`am start`), force-stop, clear data, uninstall (with/without keep-data).
- **Storage:** `/sdcard`, `/data/data/<pkg>`, app-private files; push/pull via `adb push`/`adb pull`; persists in `userdata-qemu.img` across reboots (unless wiped).
- **Networking:** NAT to host; internet works out of the box; no proxy config needed. `adb shell ping` and in-emulator browser verified.
- **Permissions:** Query via `dumpsys package`, grant/revoke via `pm grant`/`pm revoke`; runtime permission dialogs behave as on device.
- **Hardware integration (where supported):**

| Feature | Status | Notes |
|---|---|---|
| Clipboard | ✅ | Host ↔ emulator text sync |
| Files / drag-drop | ✅ | `adb push/pull`, future drag-drop |
| Camera | ⚠️ Emulated | Virtual scene by default; webcam passthrough needs `-camera-back webcam0` flag |
| Location | ✅ | `emu geo fix <lon> <lat>` — AEM Store exposes “Set to Lagos” button |
| Sensors (accel/gyro) | ✅ | Emulated, tilt via extended controls |
| Audio | ✅ | Host audio out/in |
| Graphics accel | ✅ | `-gpu auto` (host if available, else SwiftShader) |
| Rotation | ✅ | `settings put system user_rotation` |
| Screenshots | ✅ | `screencap -p` → host PNG |
| Telephony/SMS | ⚠️ Stub | Fake via `emu sms send` but no real radio |
| Bluetooth/NFC/USB | ❌ | Not emulated; test on physical device |
| Google Play | ⚠️ Optional | Requires `google_apis_playstore` image (sign-in required) |
| ARM APKs on x86 | ⚠️ | Most ARM APKs run via ARM→x86 translation (slow), but NDK libs may fail — prefer x86_64 builds |

## Quick Start

1. Open AEM Store desktop → **Emulator** tab.
2. **Install SDK** if prompted (downloads cmdline-tools, platform-tools, emulator, system image; progress bar shows phase/percent).
3. **Create AVD** if none: “aem_pixel_7” (Pixel 7 profile, 3 GB RAM, 4 cores, 8 GB storage, API 34).
4. **Start Emulator** — first boot takes 40–90s (cold), 8–15s with snapshot. Status pill shows `STARTING → RUNNING`.
5. **Install APK:** drag-drop or “Install APK File…” or from Apps tab click **EMULATOR** on any card, or “Install to Emulator” on detail page.
6. **Launch:** in Emulator → Installed applications → **LAUNCH**, or from Android launcher.

### Test APK Flow (Acceptance)

1. Ensure catalog has a ready APK (AEM Store builds publish to Supabase).
2. Start emulator.
3. In **Apps** tab, pick any app with **INSTALL**.
4. Click **EMULATOR** (desktop) → confirms “Installed to emulator”.
5. In Emulator tab, verify app appears in “Installed applications” and **LAUNCH** opens it.

Automated verification: `npm run verify:emulator` checks that manager exposes `installApk`, `start`, diagnostics, and UI contains required actions.

## Resource & Performance

### Host Requirements

| Resource | Minimum | Recommended | Check |
|---|---|---|---|
| RAM | 4 GB total | 8–16 GB (3 GB free for AVD + host) | Diagnostics → System Memory |
| Disk | 10 GB free | 20 GB (SDK 1.2 GB + AVD 8 GB + cache) | Diagnostics → Disk Space |
| CPU | Quad-core, VT-x/AMD-V | 6–8 cores, Hyper-V/WHPX | Diagnostics → Virtualization |
| GPU | Any | Dedicated GPU for host accel | Diagnostics → Graphics |
| OS | Windows 10 2004+ x64 | Windows 11 | Diagnostics → OS |

### Allocation

User can configure per-AVD: **RAM, heap, storage, cores, GPU mode, snapshot, SD card**. Defaults are balanced (3 GB RAM / 4 cores) to leave host responsive. Editing `config.ini` requires restart.

### Startup Time

- Cold boot: 40–90s (first run, or wipe-data).
- Snapshot boot: 8–15s (default quick boot).
- Subsequent: emulator keeps QCOW2 snapshots; AEM Store passes `-no-snapshot-save` to keep deterministic state unless user enables snapshots.

If boot exceeds 3 minutes, diagnostics suggest fixes (enable WHPX, add RAM, close Chrome, etc.).

### Limitations

- Emulator window is a separate QEMU window, not embedded inside AEM Store (embedding via `qemu -display none` + scrcpy/webrtc would be future work).
- Audio/video codec: software decode only; 4K video may stutter.
- DRM: Widevine L1 not supported (L3 works for testing non-DRM flows).
- Background: emulator pauses when host sleeps; no keep-alive needed.

## Architecture

```
AEM Store (Electron main)
  ├─ electron/emulator/manager.ts   ← high-level API
  ├─ electron/emulator/sdk.ts       ← download & install SDK
  ├─ electron/emulator/avd.ts       ← AVD lifecycle (avdmanager)
  ├─ electron/emulator/instance.ts  ← QEMU process & boot wait
  ├─ electron/emulator/adb.ts       ← adb wrappers
  ├─ electron/emulator/diagnostics.ts
  └─ IPC (electron/ipc.ts) → preload → renderer (EmulatorView.tsx)
```

Store and emulator responsibilities are distinct:

- **Store:** catalog, auth, artifacts, release history, discovery. Never touches `adb`.
- **Emulator:** AVDs, SDK, `adb`. Never touches Supabase except to download catalog APK URLs that Store provides.

Adding emulator did not alter Store architecture: new files live in `electron/emulator/` and `src/components/emulator/`; `App.tsx` only adds a tab and an `installToEmulator` path.

## Diagnostics

Every Emulator tab load runs `runDiagnostics()`:

- CPU virtualization (WMI/systeminfo on Windows, /proc/cpuinfo on Linux, sysctl on macOS).
- Hypervisor (WHPX/HAXM/Hyper-V on Windows, KVM on Linux, Hypervisor.Framework on macOS).
- RAM / disk / CPU cores / GPU / OS version.
- Provides `Fix:` strings with exact commands/Windows Features paths.

If `summary.canRun === false`, **Start** is disabled and a banner links to diagnostics.

## Security

- APK signature is verified by Android (`adb install` enforces signature matching; downgrade blocked unless `allowDowngrade`).
- No APK is auto-installed; user must pick file or confirm store install.
- Emulator runs as normal user, no elevation; only SDK download writes to userData.
- ADB keys are per-user in `~/.android` or `userData/emulator/home`.
