# Repository assessment and desktop architecture

## What was actually present

The starting tree was a domain-first React 19/Vite/TypeScript store backed by Supabase. `src/App.tsx` owns the catalog, search, release history, download and native-install UI. `src/services/` contains the catalog adapter, release manager, download records, notification contracts and installer/version rules. `native/` contains the substantial Capacitor Android installer and Wi-Fi Direct transfer implementation. `supabase/` and `signing-worker/` implement the existing catalog/publication/signing backend.

The working Android release workflow generates a Capacitor Android project, copies `native/`, patches its manifest and builds/signs it. The root Gradle files and `app/src/main/java/com/aem/store/MainActivity.kt` are a separate, minimal Compose wrapper, not the project used by that workflow. `mobile-index.html` also exists but the current mobile Vite config uses the normal entry point. These inconsistencies were documented rather than silently rewritten. No Windows shell, NSIS/Electron configuration, desktop update feed or emulator code existed.

The baseline `npm install` and `npm run build` passed. The desktop expansion preserves the existing Supabase client, catalog rules, Android native sources, transfer protocol, backend migrations and signing workflows. The lockfile is now committed and CI uses `npm ci`. Vite was updated within its existing major to a patched release; the production dependency audit is clean.

## Runtime decision

**Chosen: official Google Android Emulator + a persistent AVD + ADB, orchestrated locally by AEM.** It supplies a real Android OS, ActivityManager, PackageManager, permissions, networking and storage, with maintained Windows virtualization support. AEM adds product integration rather than maintaining a fork of QEMU or an Android compatibility layer. The emulator's own native window is used; inventing a low-frame-rate fake device screen would reduce usability and test fidelity.

Alternatives considered:

- **WSA:** discontinued and no longer a supported fresh-install foundation. [2](https://www.majorgeeks.com/news/story/the_end_of_a_very_short_era-microsoft-to-discontinue-windows-subsystem-for-android)
- **Genymotion Desktop:** mature, but its free edition is personal-use-only and automated/business use has licensing restrictions. That is a poor default for a distributable development/testing store. [2](https://www.genymotion.com/legal-terms-and-conditions/)
- **Custom QEMU + Android-x86/Bliss images:** possible, but would shift OS image maintenance, guest integration, input, graphics, permissions and compatibility verification into this small project. It does not improve on the official emulator for the first Windows release.
- **Cloud Android:** operationally useful in some products, but contrary to the local-first objective and introduces an ongoing service dependency/cost.
- **APK compatibility layer:** rejected because it is not the genuine Android environment requested.

The official emulator is not relicensed as AEM code. Its SDK/image terms are accepted explicitly and its binaries are downloaded separately. WHPX is Microsoft's recommended Windows acceleration path; the emulator's `-accel-check` is authoritative. [2](https://developer.android.com/studio/run/emulator-acceleration)

## Boundaries

```text
Existing React store ─────────────── existing Supabase catalog / Android client
        │
        │ typed, optional window.aemDesktop bridge
        ▼
Electron main (sandboxed renderer; validated IPC; native file dialogs)
        │
        ├── desktop update feed (separate from catalog updates)
        └── AndroidRuntime service (Node, no Electron dependency)
              ├── pinned/licensed SDK bootstrap + private JRE when needed
              ├── host diagnostics and resource configuration
              ├── official emulator process + persistent AEM_Phone AVD
              └── ADB / PackageManager / ActivityManager / explicit file transfer
```

`src/desktop/` contains only desktop UI/contracts. It is inactive in the browser/Android client. `desktop/runtime/` is independently testable. `desktop/main.mjs` owns privileged operations. `vite.config.ts`, `vite.mobile.config.ts`, `capacitor.config.json`, native Android code and Supabase remain separate.

The desktop catalog install path is intentionally distinct from the phone installer path. It sends a ready single APK to the local Android device after integrity/identity checks; it does not pretend that Windows has Capacitor's Android PackageInstaller. Existing web download behavior and Android install/update behavior remain available on their respective platforms.

## Staging and verification strategy

1. Preserve and build the original web/mobile clients.
2. Add a signed-identity-ready Windows shell and per-user NSIS installer.
3. Add diagnostics, licensed SDK setup and real local AVD lifecycle.
4. Add APK/app/permission/file/network operations with bounded IPC.
5. Build and silently install on Windows; test the installed executable, existing store UI, bridge isolation and accessibility.
6. Run the real Android verifier on a Windows host with usable WHPX; retain reports and framebuffer evidence.
7. Document hardware-only and unsupported features; do not enable other desktop targets prematurely.

The hosted Windows 2025 probe reported an AMD EPYC host, hypervisor present and `WHPX(10.0.26100) is installed and usable`. This is evidence for that runner, not a guarantee for every laptop or older Windows runner. See `docs/verification.md` for the exact build/test results and remaining gaps.
