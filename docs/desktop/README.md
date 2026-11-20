# AEM Store — Windows Desktop

> Current implementation/verification status: [transformation ledger](../TRANSFORMATION.md). Download instructions: [DOWNLOADS.md](DOWNLOADS.md). Historical claims below are not hardware acceptance evidence.

AEM Store is available as a native Windows desktop application with an integrated Android emulator. This document covers installation, first-run setup, and Windows-specific behaviors.

## Installation

### Requirements

- **Windows 10 2004 (build 19041) or newer, 64-bit**, or Windows 11. 32-bit not supported.
- **Store and emulator have different requirements**; see [host resource budgets](../host-requirements.md). A 4 GB host is not recommended for the current emulator image.
- **20 GB free disk for emulator setup** (SDK + AVD + temporary files).
- **CPU virtualization (VT-x / AMD-V) enabled in BIOS/UEFI.**
- Default Setup is **per-user**; administrator access is not required for ordinary installation. Windows hypervisor configuration may require administrator access.

### Download

1. Open [GitHub Releases](https://github.com/Emmanuel001afk/AEM/releases).
2. Download `AEM-Store-*-Setup-x64.exe` (installer) or `AEM-Store-*-Portable-x64.exe` (no install).
3. Run the installer. Choose install directory, opt into desktop shortcut.

### Reproducible Build

To build locally on Windows:

```powershell
git clone https://github.com/Emmanuel001afk/AEM.git
cd AEM
npm install
npm run build          # builds renderer + electron main
npm run build:win      # produces release/AEM-Store-*-Setup-x64.exe
```

The build uses `electron-builder` with NSIS. CI versions are `0.2.<combined run_number>` on both platforms. Android version code is `1810000000 + run_number`; `release.json` records the source revision.

On Linux/macOS you can produce an unpacked build for testing:

```bash
npm run build:unpack
```

### Startup & Identity

- **App ID:** `com.aem.store` (Windows AppUserModelID, used for taskbar grouping and notifications).
- **User Data:** `%APPDATA%/AEM Store` (logs, SDK, emulator data, caches). Uninstalled data is preserved unless you check “Delete App Data”.
- **Single Instance:** Only one AEM Store window runs. Second launch focuses the existing window.
- **File Associations:** `.apk`, `.apks`, `.xapk`, `.apkm`, `.zip` open in AEM Store and are forwarded to the Emulator tab.
- **Protocol:** `aem://` links open the store (future use).

### Interface

The desktop retains the full web store: **Home, Apps, Devices, Emulator, Updates, Transfer, Settings**.

- **Home** — featured apps, search, hero card.
- **Apps** — full catalog with search and category filters. Each card shows **INSTALL / UPDATE / OPEN** and an **EMULATOR** shortcut on desktop.
- **Emulator** — manages the local Android environment (see `docs/emulator/README.md`).
- **Updates** — apps with newer catalog releases vs. locally installed versions (scanned via Android PackageManager on device, emulator apps are managed separately in the Emulator view; desktop Updates is not yet a unified native/emulator inventory).
- **Devices** — authorized physical-phone scrcpy display, SHA-256-verified ADB push/pull and base/split export; native adapted source builds.
- **Transfer** — two local-only desktop channels: **AEM PC ↔ AEM PC** (`aem-peer/1`: invitation pairing, confirmation code on both PCs, pinned certificates, per-chunk + whole-file SHA-256, resume; see `docs/pc-transfer.md`) and the **browser companion** (`aem-lan/1`: any phone/tablet/computer browser; see `docs/lan-transfer.md`). Phone-to-phone Wi-Fi Direct stays in the Android app and authorized USB/ADB transfer stays in **Devices**. Received files land in `Downloads/AEM Transfer` and are never installed or executed by Transfer.
- **Settings** — appearance, notifications, downloads, storage, security, and a **Desktop & emulator** section.

### File & App Access

- The desktop app can read any file the user picks via the system file dialog (no sandbox restriction like a browser).
- Network access is unrestricted (HTTPS to Supabase catalog, GitHub releases, Android SDK `dl.google.com`).
- Downloads go to `userData/downloads` and are then handed to the Android installer (on device) or `adb install` (in emulator).
- The app does **not** require administrator after install, except for hypervisor toggles.

### Auto-Updates

- Catalog updates are live from Supabase — no app update needed.
- Desktop app updates are delivered via GitHub Releases. The app checks `api.github.com/repos/Emmanuel001afk/AEM/releases/latest` and shows a banner when a newer version is available. Download is manual (NSIS installer will auto-uninstall old version).

### Troubleshooting

| Symptom | Fix |
|---|---|
| Installer blocked by SmartScreen | Verify the download source and checksum first. Windows builds are unsigned; AEM does not bypass SmartScreen. |
| App shows blank white screen | Check `logs/` in userData, or run with `AEM_STORE_DEBUG=1 AEM-Store.exe`. |
| “APK opened” not going to emulator | Ensure emulator is **Running** (green badge). Non-running shows a hint. |
| Transfer pairing never arrives | Both PCs must be on the same private network and AEM must be allowed on **private** networks in Windows Firewall. See the troubleshooting table in `docs/pc-transfer.md`. |
| “Peer TLS certificate does not match the pinned fingerprint” | The other PC rebuilt its identity (fresh profile/reinstall) or the code came from another machine. Unpair and re-pair with a new invitation. |

---

## Architecture for Future Platforms

The Electron main process is platform-agnostic:

- SDK root, AVD home and userData are resolved via `app.getPath`.
- All emulator ops go through `adb`/`emulator` CLI — identical on macOS/Linux.
- macOS (`darwin`) and Linux use the same `diagnostics.ts` checks (KVM on Linux, Hypervisor.Framework on macOS).
- `electron-builder.yml` already declares `mac` (dmg/zip) and `linux` (AppImage/deb) targets. Windows is the primary release gate; other platforms will be enabled after Windows validation passes without delaying it.

To add macOS/Linux installers:

1. Test `npm run build` on that OS.
2. Add signing config (`appleId`, `cscLink`) for macOS, no extra for Linux.
3. Enable CI jobs (see `.github/workflows/aem-desktop.yml`).

No store-architecture changes are needed.
