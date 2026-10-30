# Verification record

This record describes what was actually executed for the Windows-first AEM Store desktop expansion. It is not a substitute for the linked CI artifacts.

- Date: **2026-10-30**
- Branch: `arena/32bd333b-aem`
- Verified application commit: **`96c5c1c`**
- Application version: **0.2.0**
- Primary release target: **Windows x64**

## Result summary

| Area | Result | Evidence |
| --- | --- | --- |
| Existing web and Capacitor Android builds | PASS | Windows workflow step “Preserve web and Android client builds” |
| Runtime unit tests | PASS | 15/15 in CI and locally |
| Production dependency audit | PASS | `npm audit --omit=dev`: 0 vulnerabilities |
| Windows NSIS installer build | PASS | `AEM-Store-0.2.0-windows-x64-Setup.exe` |
| Silent per-user Windows install | PASS | `/S` install, executable identity, Start Menu shortcut, HKCU uninstall key |
| Normal installed startup | PASS | Real Electron window titled `AEM Store` |
| Installed store UI and discovery | PASS | Playwright against the installed executable |
| Integrated Android UI | PASS | Setup consent, tabs, diagnostics and honest stopped/setup states |
| Renderer sandbox and bridge boundary | PASS | No Node globals, HTTPS-only external links, path traversal rejected |
| Accessibility | PASS | axe-core WCAG A/AA checks on the Android interface; no serious/critical violations |
| Silent Windows uninstall | PASS | `/S` uninstall; user data intentionally retained |
| Licensed Android runtime setup | PASS | Private Temurin JRE + Android SDK components installed after explicit license acceptance |
| CPU acceleration | PASS | `WHPX(10.0.26100) is installed and usable.` |
| Genuine Android boot | PASS | Android 15 / API 35, `emulator-5556`, **179 s** cold boot in CI |
| Signed test APK install | PASS | `com.aem.runtimeprobe`, 12,685 bytes |
| App launch and private storage | PASS | Real Activity launched; private file written and read |
| Guest-to-host networking | PASS | Android reached the host probe over emulator NAT |
| Android permission grant/revoke | PASS | Camera permission changed and observed by the app |
| Bidirectional file transfer | PASS | Host → Android Downloads → Host round trip |
| ADB development port forwarding | PASS | `adb reverse tcp:8765` registered |
| Real framebuffer screenshot | PASS | `android-probe.png` captured from Android |
| Persistence across device restart | PASS | Installed app and private storage survived stop/start |
| Android app uninstall | PASS | Package removed through AEM runtime |

## Authoritative CI runs

### Windows desktop

Run: <https://github.com/Emmanuel001afk/AEM/actions/runs/41063004744>

- Runner: `windows-2025-vs2026`
- Installer: `AEM-Store-0.2.0-windows-x64-Setup.exe`
- Installer size: **122,201,396 bytes**
- Installer SHA-256: `244c9cf317ad744781d5e7fc53397595c27ca55612bea4cd9817f75f50f27a93`
- Playwright: **4 expected, 0 unexpected, 0 skipped**
- Artifacts:
  - `aem-store-windows-installer` — installer, `latest.yml`, verification sidecar
  - `windows-desktop-verification` — startup evidence, Playwright report, screenshots and accessibility attachment

The installer is **unsigned** in this run because no Windows code-signing certificate was provided. Electron Builder is configured to enforce Authenticode signing when the repository’s `WINDOWS_CSC_LINK` / certificate secrets are present.

### Android runtime

Run: <https://github.com/Emmanuel001afk/AEM/actions/runs/41063004987>

- Runner: `windows-2025-vs2026`
- Host: Windows Server 2025 Datacenter, `10.0.26100`, x64
- CPU: Intel Xeon Platinum 8370C, 4 logical processors
- RAM: 16,379 MB total
- Acceleration: Windows Hypervisor Platform, usable
- Android image: API 35 `google_apis` x86_64, **no Play Store**
- Emulator: 37.2.13 rolling package, recorded in `runtime-lock.json`
- Platform-tools: 37.0.1 rolling package, recorded in `runtime-lock.json`
- Test APK SHA-256: `6f7889a7b2073b7bb32d7146d74152b7c0b4148eabfa9c542baa02ee0328dda8`
- Test APK signing certificate SHA-256: `f410de537ae98086cc06c4447c1023db183596eeaf8a72f4187d9d7212fa67d5`
- Artifact: `android-runtime-verification` — report, framebuffer screenshot, test APK, runtime lock and logs

The 179-second boot time was measured on a nested-virtualization CI runner with software graphics. It is evidence that the runtime works, not a promised boot time on a physical Windows desktop.

## Local checks

The development sandbox is Linux and cannot execute the Windows Electron installer or Windows Android emulator. These checks were run locally and repeated in Windows CI:

```bash
npm ci
npm run test:unit
npm run typecheck
npm run build
npm run build:desktop
npm audit --omit=dev
```

Local result: unit tests 15/15, typecheck clean, web/desktop builds clean, production audit 0 vulnerabilities.

## Reproduce

Windows release verification:

```bash
npm ci
npm run verify:win
```

Real Android verification on Windows x64:

```bash
node scripts/verify-android.mjs --accept-licenses --headless
```

`--accept-licenses` is an explicit action. The application does not silently accept the Android SDK or Temurin licenses, and it does not bundle those components in the installer.

## Known gaps and limits

- **Unsigned installer:** Windows SmartScreen will warn until a trusted certificate is configured and a signed release is built.
- **Physical camera/microphone:** CI has no camera. Camera/microphone sharing is off by default; physical hardware passthrough was not verified.
- **Host GPU:** CI used software graphics. Host GPU mode is exposed but was not acceptance-tested on a physical GPU.
- **ARM Windows:** unsupported in this release; the runtime image and installer are x64.
- **Play Store:** intentionally absent. The selected image is Google APIs, not a Play Store device image.
- **Split APK families:** desktop catalog installation currently requires a single APK. Split APK installation remains available in the existing Android store client.
- **macOS/Linux desktop:** not built or verified yet. The architecture keeps the runtime boundary separate so future support is possible, but Windows is the completed target.
- **CI boot time:** nested virtualization and software rendering are slower than a typical accelerated desktop. Diagnostics remain the source of truth on each host.
