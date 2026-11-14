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

This ledger is not a completion certificate. See the final verification section below for changes and executed checks. The CI evidence below supersedes the initial unverified baseline. Physical two-phone/phone-PC transfers, phone mirroring/OEM desktop mode and Dell Latitude 3190 performance still require hardware evidence.


## Executed repair and acceptance evidence — 2026-11-14

- Fixed existing Android `active` receive-scope compilation error in `native/AemTransferActivity.java`; preserved package/signing identity and Wi-Fi Direct flow.
- Repaired NSIS custom syntax, executable resource editing and electron-builder 26 configuration. Fixed a smoke-test false negative: NSIS default DisplayName includes the version. Converted mislabelled PNG `apk.ico` to real six-size ICO using the existing artwork. `icon.ico` is valid; the unused macOS `icon.icns` remains a mislabelled PNG and macOS delivery is not validated.
- Added shared release version stamping, Android signing/package verification, PE/signature-header checks, complete three-file checksums, gated main-only GitHub publication and draft download validation. No release has been published or PR merged in this session.
- Replaced fixed emulator allocations with measured host/free RAM/CPU/disk and actual acceleration diagnostics. Added safe package extraction, API/ABI/signer preflight and SDK/process improvements; no universal APK compatibility claims.
- Added Android-authorized ADB file copies both directions, SHA-256 verification, base/split export and separately consented scrcpy phone-powered display. Fake-ADB orchestration tests are labelled test doubles, not physical-device evidence.
- Added independent Windows catalog-version selection, manual/recommended execution methods, trusted native source build and consented native EXE delivery. Added actual Windows registry-version discovery and update/downgrade comparison; never count opening an installer as installed success.
- Added AEM-side partner identity/capability contracts. **These remain contracts only**, not live authenticated integrations.

### Successful workflow runs

1. [43583736280](https://github.com/Emmanuel001afk/AEM/actions/runs/43583736280), source head `b0d80ae`, version **0.2.11**: signed APK and real Setup/Portable EXEs; Windows install/renderer/registration/shortcuts/same-version reinstall/user-data preservation/portable/uninstall passed; signed Android APK installed, accessible Store UI detected, same-version reinstall/relaunch passed on API 29 x86_64 AVD; complete bundle checksum verification passed.
2. [43584297929](https://github.com/Emmanuel001afk/AEM/actions/runs/43584297929), source head `17f280d`, version **0.2.12**: all above plus installed icon pixel comparison, **cross-version Windows upgrade 0.2.11 → 0.2.12** with actual user-data preservation, and real native fixture build/install/window/shortcut/registration/uninstall. 37 unit tests and six JVM archive scenarios passed. These jobs exercised real Windows/Android runtimes, not only compilation.

Both are PR builds; `release.json` records the tested GitHub PR merge revision. Main-only publish correctly skipped. Windows binaries are not Authenticode-signed.

### Downloadable 0.2.12 CI artifacts

GitHub login may be required. Artifacts expire; these are not permanent GitHub Releases.

- [Complete deliverable set](https://github.com/Emmanuel001afk/AEM/actions/runs/43584297929/artifacts/14109424760) (239,255,595-byte GitHub artifact ZIP).
- [Setup + Portable](https://github.com/Emmanuel001afk/AEM/actions/runs/43584297929/artifacts/14109254747).
- [Signed Android APK](https://github.com/Emmanuel001afk/AEM/actions/runs/43584297929/artifacts/14109074856).

Verified by the workflow after downloading all platform artifacts into its bundling job:

```text
22b6f816384ce4922f03503fa6e1dea4688a90d0f660adf52a9a19e76a5b85b0  app-release.apk
5554ce0aaf8d98e47aa6d8184b1f6520996e77e1ff77aa4053b9b88c51033fb0  AEM-Store-0.2.12-Setup-x64.exe
bc7d905f4befae701b466de0be3dcc5058ab986e2439e79b93f848b76041341f  AEM-Store-0.2.12-Portable-x64.exe
```

Local retrieval via `gh run download` was attempted and failed at the Azure artifact host (EOF, outside this sandbox's outbound allowlist). Do not claim locally downloaded/rehashed files. CI did download and hash them successfully. Published-release re-download verification awaits an authorized main build/publication.

### Additional work awaiting CI at this ledger revision

40 local unit/integration-double tests and renderer/Electron builds pass. Added expected catalog signing-certificate enforcement, native registry detection with Windows runtime assertions, and a real AEM-managed API 34 AVD lifecycle job under Electron/Linux KVM. This job uses a CI-provisioned SDK and will not establish Windows hypervisor, AEM SDK downloader or physical Latitude behavior. Its outcome must be recorded separately.

### Explicitly incomplete

- Secure AEM-to-AEM LAN discovery/pairing, encrypted transport, bidirectional progress/resume and interruption/authentication tests: **not implemented**. Existing phone-phone path retained; authorized ADB copies are not a substitute for LAN/resume.
- A licensed third-party Android application adapted to native Windows source: **not delivered**. WinForms fixture proves tooling only. Arbitrary proprietary APKs cannot supply missing source/components or entitlements.
- Live authorized EMA/OEA/Phormi/Central Hub transport/consent UI: **not implemented**. No external repository or database changed/merged.
- Supabase sync/publish currently ingests Android artifacts only; native Windows artifacts require a catalog publishing extension or curated records. Do not imply published native variants exist merely because a selector/build route exists.
- Android physical install/update/permissions/settings, physical Wi-Fi Direct, both physical transfer directions, interruption recovery, phone-powered display, OEM desktop, DRM-restricted apps, cross-version Android updates and Dell Latitude 3190 4GB usability: **not verified**. No attached devices or Windows laptop available locally. CI runtime checks cover narrower cases only.
- Main release publication and permanent latest download page: code is gated, but publication not executed; draft PR #10 remains unmerged.
- Dependency audit: 6 moderate development/build-time issues; production audit has no advisories. Avoid a forced incompatible builder downgrade.
