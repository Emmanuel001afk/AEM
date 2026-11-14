# AEM Store — Windows Desktop

AEM Store is available as a native Windows desktop application with an integrated Android emulator. This document covers installation, first-run setup, and Windows-specific behaviors.

## Installation

### Requirements

- **Windows 10 2004 (build 19041) or newer, 64-bit**, or Windows 11. 32-bit not supported.
- **4 GB RAM minimum, 8 GB+ recommended** (emulator needs 3 GB free).
- **10 GB free disk minimum, 20 GB recommended** (SDK + AVD + logs).
- **CPU virtualization (VT-x / AMD-V) enabled in BIOS/UEFI.**
- **Administrator privileges** for first install (to register file associations and create Start Menu shortcuts). Subsequent updates do not require admin.

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

The build uses `electron-builder` with NSIS. Version is from `package.json` (`0.1.0` → `0.1.<run_number>` in CI). The CI stamp is deterministic: `1800000000 + days*1000 + run_number%1000`.

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

The desktop retains the full web store: **Home, Apps, Emulator, Updates, Transfer, Settings**.

- **Home** — featured apps, search, hero card.
- **Apps** — full catalog with search and category filters. Each card shows **INSTALL / UPDATE / OPEN** and an **EMULATOR** shortcut on desktop.
- **Emulator** — manages the local Android environment (see `docs/emulator/README.md`).
- **Updates** — apps with newer catalog releases vs. locally installed versions (scanned via Android PackageManager on device, via ADB on emulator).
- **Transfer** — bidirectional phone ↔ PC transfer on desktop (discover phones on the LAN, send files to phone, receive files from phone, SHA-256 verified, resumable); phone-to-phone Wi-Fi Direct remains on the Android app.
- **Execution methods** — each app card/detail shows the available ways to run it: Android emulator, native Windows (EXE/MSIX), or phone-powered desktop, with a recommendation and clear reasons when a method is unavailable.
- **Settings** — appearance, notifications, downloads, storage, security, and a **Desktop & emulator** section.

### File & App Access

- The desktop app can read any file the user picks via the system file dialog (no sandbox restriction like a browser).
- Network access is unrestricted (HTTPS to Supabase catalog, GitHub releases, Android SDK `dl.google.com`).
- Downloads go to `userData/downloads` and are then handed to the Android installer (on device) or `adb install` (in emulator).
- The app does **not** require administrator after install, except for hypervisor toggles.

### Auto-Updates

- Catalog updates are live from Supabase — no app update needed.
- Desktop app updates are delivered via GitHub Releases. The app checks `api.github.com/repos/Emmanuel001afk/AEM/releases/latest` and shows a banner when a newer version is available. Download is manual (NSIS installer will auto-uninstall old version).

### Native Windows Delivery

Not every Android app can become native Windows. AEM Store reports this honestly per app:

- If a Windows artifact (EXE/MSIX) is published for the app, the **Native Windows** method is available — install and run directly, no emulator.
- If no Windows artifact exists, AEM Store shows a **"cannot convert"** note explaining that a Windows build must be authored and published; it is not derived automatically from the Android APK.

### Cross-Platform Recognition (AEM side only)

AEM Store recognizes sister AEM-family products on the device — **AEM Store, EMA, OEA, Phormi, Central Hub** — so you can see coherent "installed elsewhere" status and hand off between them. Each product owns its own database and identity; **AEM Store never merges identities or databases**, and makes no changes to any other repository.

### Troubleshooting

| Symptom | Fix |
|---|---|
| Installer blocked by SmartScreen | Click “More info” → “Run anyway”. The build is not EV-signed yet; publisher is “AEM Team”. |
| App shows blank white screen | Check `logs/` in userData, or run with `AEM_STORE_DEBUG=1 AEM-Store.exe`. |
| “APK opened” not going to emulator | Ensure emulator is **Running** (green badge). Non-running shows a hint. |
| Transfer tab says “Android app” | Transfer is Android-to-Android only; desktop shows info. Use Emulator for APK testing. |

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
