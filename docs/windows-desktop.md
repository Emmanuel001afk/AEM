# AEM Store for Windows

AEM Store remains one product: the existing React/Supabase catalog, release discovery and Android installer, plus a Windows desktop shell and a locally managed Android test device. The desktop work does not replace the Capacitor Android client, Supabase schema, signing worker or release pipeline.

## Install and first run

1. Obtain `AEM-Store-0.2.0-windows-x64-Setup.exe` from the **AEM Store Windows release** workflow artifact or a published `desktop-v*` GitHub release. Do not substitute the tiny Android test APK for the desktop installer.
2. Run the installer. It defaults to a per-user installation under `%LOCALAPPDATA%\Programs\AEM Store`, creates Start Menu/desktop shortcuts and registers an uninstaller. Administrator access is not needed for this default.
3. Open **AEM Store**. The existing catalog loads from the same Supabase project. Its publishable client key is not an administrator credential.
4. Open **Emulator → Device**, review the host checks and license links, accept the licenses, and choose **Download & install Android**. Keep AEM open during setup. The Windows installer does not silently bundle or accept Google's system images.
5. After setup, check CPU virtualization and choose **Start Android**. Google's Android Emulator opens in its own native window. AEM remains the control surface for APKs, installed apps, permissions, files, resources and diagnostics.
6. In **Applications**, choose a local APK, inspect its package/version/signature, and install it. Alternatively, install a ready, single-APK catalog application from its store page. Launch installed apps from AEM or inside Android.

AEM does not pretend that the emulator window is a Windows application or an embedded web screenshot. It is the official emulator's real Android window, with its lifecycle and device operations integrated into the store. There is no simulated Android home screen and no remote execution requirement.

## Host requirements

- 64-bit Windows 10/11 on Intel/AMD x86-64. Windows on ARM is not a supported host for this release.
- Intel VT-x or AMD-V/SVM enabled in firmware. **Windows Hypervisor Platform (WHPX)** is the recommended Windows CPU backend. WHPX requires a supported Windows edition/configuration and generally a restart after enabling it. Google's emulator reports the definitive acceleration check; AEM uses that result rather than guessing from a CPU name. [2](https://developer.android.com/studio/run/emulator-acceleration)
- At least 4 GB host RAM for setup; 8 GB or more recommended. AEM initially limits guest RAM to at most half of host RAM. The verification device uses 2 GB and two cores.
- At least 8 GB free for setup; 16 GB or more recommended for apps and growth. The virtual data disk starts at 8 GB and can grow; shrinking requires a device reset.
- A current GPU driver is recommended. Host graphics can be selected explicitly; software graphics is a compatibility fallback. **Software graphics does not remove the CPU virtualization requirement.**
- Internet access for the existing catalog and the initial licensed runtime download. Android execution, APK installation and local file transfer do not require a cloud emulator.

If acceleration fails, enable virtualization in firmware and Windows Hypervisor Platform in Windows Features, restart, and rerun diagnostics. Conflicting hypervisors, security features, Windows edition limitations or a host VM without nested virtualization can prevent acceleration. AEM does not silently install kernel drivers, disable security features or change firmware. Google's command-line emulator remains the supported underlying runtime even as newer Android CLI tooling evolves. [1](https://developer.android.com/studio/run/emulator-commandline) [3](https://developer.android.com/tools/agents/android-cli/commands/emulator)

## Runtime and licensing

The runtime manager uses Google's SDK command-line tools, Emulator, platform-tools/ADB, build-tools and a **Google APIs Android 15 (API 35), x86-64** system image. This is a full Android virtual device, not an APK compatibility layer. The image does not include the Play Store; Play-Store-only licensing, integrity or services are not promised.

Bootstrap inputs are pinned in `desktop/runtime/manifest.mjs`. The current pins are command-line tools 13114758, Temurin JRE 21.0.13+9, build-tools 35.0.1 and the API 35 platform/Google APIs x86-64 image. Google's SDK manager exposes platform-tools and Emulator through rolling, unversioned package IDs; the Windows probe found 37.0.1 and 37.2.12 respectively. The exact installed revisions are recorded in `runtime-lock.json`. Rolling packages and the system-image repository revision can change; retain the runtime lock and verification report for an exact tested environment. A future improvement is a fully versioned, privately mirrored image lock with license-compatible redistribution.

The command-line tools and private Java archive are SHA-256 checked. SDK packages are downloaded by Google's SDK manager after explicit license acceptance. Java is GPLv2 with Classpath Exception; Android SDK components and system images have their own terms. No Google binaries, images or Java runtime are committed to this repository. Temurin is downloaded only when a suitable Java runtime is not already available (CI can force the private path for verification).

## Data locations and file access

- Application preferences and catalog identity: Electron's per-user AEM Store data directory.
- Android SDK, private Java, AVD, logs and staging: `%LOCALAPPDATA%\AEM Store\android-runtime` by default.
- Android apps/private data: the persistent `AEM_Phone.avd` data partition.
- Explicitly shared files: `/sdcard/Download/AEM` inside Android.

Uninstalling AEM intentionally retains preferences and Android data. **Reset Android data** in Diagnostics deletes the device's apps/accounts/files after confirmation, but keeps the SDK. Closing AEM requests an orderly emulator shutdown. A forced process kill or power loss can require recovery; the next startup checks the recorded AEM-owned process before recovery.

AEM does not mount the Windows filesystem into Android. File dialogs grant access only to selected files. Pulls are restricted to the shared Android Downloads/AEM folder. APKs are installed through ADB into Android; they are never executed as Windows binaries.

## Android and Windows capabilities

| Capability | Implementation / boundary |
| --- | --- |
| Install/update APK | ADB install with data retention; APK signature verified; catalog SHA-256, package, signer and version checked |
| Launch apps | Real Android launcher Activity via ActivityManager |
| Installed apps | Third-party Android packages and actual version metadata |
| Permissions | Android runtime grant/revoke through PackageManager; special access opens Android Settings |
| Storage | Persistent AVD data partition; explicit push/pull; data usage reported by Android `df` |
| Networking | Emulator NAT; host address `10.0.2.2`; explicit ADB reverse TCP forwarding |
| Camera | Optional default webcam mapping; Windows camera privacy access and Android CAMERA permission still required. Google's emulator supports webcam startup mapping. [1](https://developer.android.com/studio/run/emulator-commandline) |
| Microphone | Optional host audio input; Windows privacy access and Android RECORD_AUDIO permission still required |
| Graphics | Auto, host GPU or software rendering; CPU acceleration remains mandatory |
| Keyboard/clipboard/sensors | Provided by the official emulator where supported; AEM does not claim custom clipboard, GPS, Bluetooth or USB passthrough |

Camera/microphone toggles apply on the next boot and are off by default. Actual laptop camera/microphone capture must be checked on the target hardware; a CI virtual machine is not evidence that a physical webcam works. ARM-only native libraries may need image translation and can fail. Split APK/APKS/XAPK/APKM desktop installation is not implemented yet; those existing Android-client families are not removed from the store. The desktop explicitly rejects them instead of installing an incomplete package.

## Security boundaries

- The renderer loads packaged assets through a privileged, traversal-checked `aem://store` protocol, not a remote website. Development mode permits only the fixed loopback Vite origin.
- Electron uses context isolation, renderer sandboxing, no Node integration, no webviews, restrictive CSP and denied browser permission requests.
- The preload exposes named operations, not a generic command or IPC bridge. The main process checks the calling frame and origin.
- Runtime commands use fixed executables and argument arrays; package names and permissions are validated. There is no renderer-supplied shell command.
- Local APK paths come from native file dialogs and short-lived selection tokens. Android pulls use a native save dialog and a restricted guest directory.
- Bootstrap archives reject traversal/symlink entries and verify pinned hashes. Store downloads require HTTPS from AEM storage/GitHub and a catalog SHA-256.
- A valid APK signature proves signer consistency, not that an app is safe. AEM does not claim malware detection. Local APK installation is an explicit user action.

## Build and verify locally

Use Node 22.12+ and npm on **Windows x64** for the release build. A JDK 21 is needed only for building the test APK; end users get a private JRE when required.

```powershell
npm ci
npm run test:unit
npm run build                 # original web client
npm run build:mobile          # original Capacitor web assets
npm run dist:win              # real NSIS installer + latest.yml + checksum report
npm run test:desktop          # tests unpacked app by default
```

To test the installed product rather than the unpacked build, run the installer, then:

```powershell
$env:AEM_TEST_EXECUTABLE = "$env:LOCALAPPDATA\Programs\AEM Store\AEM Store.exe"
npm run test:desktop
```

For a real Android end-to-end run (large licensed download; destroys only its isolated verification device):

```powershell
$env:AEM_RUNTIME_ROOT = "$env:TEMP\aem-runtime-verification"
npm run test:android -- --accept-licenses --headless
```

The verifier installs the runtime, checks acceleration, boots Android, builds a genuine signed test Activity with SDK tools, installs and launches it, checks private storage and guest-to-host networking, grants/revokes CAMERA, round-trips a file, registers an ADB reverse port, captures the Android framebuffer, restarts to verify persistence, and uninstalls the test app. It writes `verification-report.json`. Failure to boot is a failed verification, not a successful build with a disclaimer.

The Windows workflow also installs silently, checks executable identity/shortcut/uninstall registration, runs Playwright and axe against the **installed** app, and verifies silent uninstall. The Android workflow runs the same runtime service used by the desktop bridge. Reports are uploaded and published as readable GitHub check summaries.

## Updates, signing and release status

The original catalog update mechanisms remain intact. Desktop application updates are separate: electron-updater reads `latest.yml` and the installer from the AEM GitHub release feed, verifies the release checksum, asks before downloading, and asks before restarting. Publish the installer, blockmap and `latest.yml` together. The repository's Android/Supabase publication workflow is not replaced.

The workflow accepts `WINDOWS_CSC_LINK` and `WINDOWS_CSC_KEY_PASSWORD` for electron-builder Authenticode signing. If those secrets are absent, the artifact is **unsigned**, and Windows SmartScreen may warn. A checksum is not a code-signing certificate. A public release should use the owner's certificate and reviewed release notes. The workflow's optional publication job creates a **draft** from `main` only; it does not auto-publish or merge code.

macOS and Linux packaging are deliberately not enabled. The runtime lifecycle is separated from Electron and the store, but those hosts need their own image, acceleration, packaging and hardware verification before support is claimed.
