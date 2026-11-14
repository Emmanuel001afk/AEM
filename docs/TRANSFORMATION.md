# AEM multi-platform implementation and verification ledger

## Baseline — 2026-11-14, base 89df759

Repository inspected: shared React catalog/installer/version/download services; Capacitor Java installer and 4,686-line Wi-Fi Direct transfer activity; Electron main/preload/IPC; SDK, AVD, ADB and emulator process management; icons/NSIS; all eight workflows; Supabase migrations/functions and signing worker; legacy Gradle `app/` and in-repository `oea/` module. The shipping Android workflow generates a Capacitor project from `native/` and `src/`, **not** the root Compose application. No changes to separate application repositories are authorized.

Preservation boundaries: com.aem.store, existing icon assets, Android signing secrets/certificate, catalog and Supabase storage, native installer and transfer protocol 6, settings, emulator, Setup and Portable targets. The `oea/` sources are not the shipping Capacitor product and are not a substitute for an authorized OEA integration.

### Actual baseline evidence

- `npm ci --ignore-scripts`: success; initial dependency audit 19 vulnerabilities (4 moderate, 14 high, 1 critical). Electron binary download intentionally skipped in this restricted Linux environment.
- `npm run build`, `npm test`, `npm run verify:emulator`: success. The latter is a **static source check**, not execution acceptance. `scripts/test-emulator-install.mjs` is a simulation, not a hardware test; fixture APK must not be treated as a signed test app.
- GitHub API: combined run 41064903250 succeeded, artifacts: APK 3,007,544 bytes; Windows 171,889,071 bytes; combined 174,896,900 bytes. PR run 41197918024 succeeded after Android transfer compile fix; preceding main run 41192700845 failed. These are historical builds, not builds of this branch.
- `gh release list`: no published GitHub releases. Combined workflow only uploaded artifacts; self-publish ingests Android only. This explains the confusing download route, but does **not** establish which file the user previously opened with WinRAR.
- Central signing run 43572336253 failed at “Sign pending AEM Android APKs”. Detailed log download is blocked (results-receiver.actions.githubusercontent.com is not an allowed host). Root cause cannot be asserted from step names.
- No Java, Gradle, Android SDK/ADB, Wine, Windows host or attached Android device here. Google SDK/Maven and Actions artifact/log/CDN hosts are outside outbound allowlist. No new APK or EXE can honestly be claimed from local compilation.

### Defects found

1. Size-only Windows validation, missing-release download route, constant desktop version versus Android run version, cross-run Android concurrency cancellation, signing verification absent before APK upload. Windows executable resource editing disabled; incorrect unpacked executable expectation merely logged instead of failing.
2. Hard-coded 3072 MB/four cores, free RAM ignored, Windows WMIC plus Unix `head`, virtualization inferred from the words Hyper-V even in negative systeminfo output, snapshots never saved, unsafe AVD names and destructive create-over-existing.
3. Unrestricted external schemes/navigation and unvalidated IPC sender; update comparison by unequal tag permits downgrades and false notifications from HTTP error JSON.
4. Split archives extracted by shell, Windows quoting injection, no zip-bomb bounds, all alternative splits installed together, ZIP magic accepted as application validity; package compatibility not inspected before installation.
5. Desktop LAN transfer absent. Android protocol 6 supports consent, offsets, hashing and app base/split export, but no authenticated encrypted LAN service. Preserve it while adding a separately versioned channel; do not label plain TCP pairing secure.
6. No native application adaptation/build registry or phone-powered session coordinator. Phormi integration is only a TypeScript contract. Shared domain already distinguishes platform artifacts but not verified port provenance or method readiness.

## Execution plan

1. Repair release publishing, signature/PE verification, Windows installation smoke automation, identity/version linkage and Electron security; preserve Android catalog publisher.
2. Add pure tested host-budget policy integrated with actual diagnostics/AVD creation and startup; fail closed on unknown acceleration; add low-resource analysis without performance claims.
3. Harden archive inspection and split compatibility, add runtime tests with malicious inputs. Never interpret APK bytes as portable Windows source code.
4. Add authorized phone execution coordination using locally installed open-source scrcpy and ADB; keep phone execution separate from emulator and OEM desktop mode. Add explicit method availability/manual selection.
5. Develop remaining encrypted LAN channel with Android NSD, native source adaptation recipes, independent ecosystem authorization and real-device regressions. Track incomplete pieces explicitly instead of marking interfaces done.

## Acceptance status

This ledger is not a completion certificate. See the final verification section below for changes and executed checks. All Android install/launch/signing regression, Windows installer/shortcut/icon/upgrade/uninstall validation, SDK/AVD startup and installed-app launches, two-phone and phone/PC transfer, phone mirroring, OEM desktop mode and Dell Latitude 3190 performance require additional CI/hardware evidence.
