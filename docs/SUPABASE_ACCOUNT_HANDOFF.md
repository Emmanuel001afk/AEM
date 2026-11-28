# AEM destination Supabase setup — current handoff

Updated 2026-11-22. This records observed setup and remaining limitations. No secret values belong in this file, Git, or chat.

## Update — 2026-11-27

The owner intentionally includes public and private repositories and accepts that their store artifacts can be public. EMA's existing large debug APK/source-signing behavior is accepted; do not replace it solely to address that exception.

Migration `20261127105514_aem_oea_launcher_catalog_only` is applied to the destination. Anonymous and authenticated catalog reads now expose only the OEA launcher APK (`com.oea.launcher`), not the six separate game APK records. No objects or rows were deleted; storage URLs already known remain accessible. An anonymous-role check returned seven launcher records and no game packages.

The checked-in sync and store updates on the working branch are **not deployed**. They add release-over-debug selection, strict package matching, Windows workflow fallback, scan warnings and additional release pagination, and keep debug and release APK retention separate. The live sync function's full source could not be retrieved for a safe comparison with this checkout, so it has not been replaced. Large workflow archives and private binaries above the existing limits remain unsupported; resolving this requires a tested streaming/background import path rather than simply raising Edge memory limits. A physical-device test is still needed to confirm the OEA launcher includes and runs its games.

The remainder of this document is a historical handoff from November 22 and is not a current inventory of deployed versions or artifacts.

## Destination and storage safety

- Supabase org AEO (`tzqhxxbljvumijeejzfy`), project AEM (`zaaauldrktvytskerpmc`), region `eu-west-1`.
- No historical database rows or Storage objects were transferred. The destination bucket was empty before the controlled discovery test.
- `aem_functional_core_bootstrap` created the ten AEM public tables, policies/RLS, triggers/RPCs, `aem-artifacts`, and `pgcrypto`, `pg_net`, `pg_cron`.
- `aem_storage_budget_guard` and `aem_service_role_table_grants` are applied. A database trigger rejects new/replaced `aem-artifacts` objects once the bucket would exceed 900 MiB, reserving about 100 MiB under the stated 1 GiB allowance. Service-role SQL grants were necessary for Edge Function writes.
- Latest readback after retention and signing: 14 Storage objects / 142,522,732 bytes (14 APKs). The 900 MiB guard prevents quota overrun; the deployed sync also prunes obsolete APK objects via the Storage API.
- Vault contains `aem_project_url`, `aem_publishable_key`, and `aem_sync_secret`. Edge secrets `AEM_GITHUB_TOKEN` and `AEM_GITHUB_DISPATCH_TOKEN` are configured; values are not recorded.

## Automatic repository discovery — first completed run

The deployed `aem-sync-github` scans repositories visible to the authenticated `Emmanuel001afk` GitHub token (owner, collaborator, organization-member affiliations), then inspects each default branch, the two newest releases that contain matching files, and the latest successful Actions run. It recognizes `.apk`, `.apks`, `.xapk`, `.apkm`, and `.exe`; no per-repository manual registration is needed. The first full run authenticated as the expected account, scanned 10 repositories, completed with no failed repositories, created 4 application records, 7 release records, and 21 artifact records. The destination now has 6 application rows total, including AEM Store, EMA, MAARY-BASE, mayobuild-studio, OEA, and Phormi. Repositories with no qualifying detected binary are skipped.

- Edge Function `aem-sync-github`: ACTIVE, version 15, JWT verification off. The function processes one repository per invocation and stores a cursor in `source_sync_state` because an unbounded scan hit the Edge worker resource limit. Cron `aem-github-source-sync` is active every five minutes. The latest full v15 scan completed across 10 repositories with 0 failures; recurring scans continue automatically.
- GitHub Actions archive detection uses artifact-name hints (APK/Android/build/release/Windows/EXE) and rejects large archives. Arbitrarily named workflow artifacts and private large binaries can be missed; widen safely only if those sources are actually used.
- Large public GitHub Release EXEs (>50 MiB) are catalogued by their public GitHub download URL and SHA-256 rather than copied into Supabase Storage. This is how the AEM desktop installers were discovered without consuming the 1 GiB bucket. Large private EXEs cannot use that public-link path and are skipped. Smaller binaries/APKs are copied into the AEM bucket.
- The token must include future repositories and any private repositories that should be visible. The first successful run proves access to the 10 repositories returned by the token at that time; it does not prove owner-wide access to future repositories. Use an owner-wide/all-repositories read credential with Contents: Read and Actions: Read. Keep `AEM_GITHUB_DISPATCH_TOKEN` separate and scoped to AEM signing dispatch.

## Storage retention and APK readiness

The deployed v15 sync keeps APK artifacts from the two newest APK-bearing release groups per app and removes older APK objects through Supabase Storage APIs, retaining each release's non-APK records. It also avoids importing malformed APKs or creating a release row when all candidate APKs are invalid. No historical bulk import ran. This policy was exercised during a full 10-repository scan with 0 repository failures; the observed object count dropped from 16 to 15 and usage from 159,829,453 to 142,268,566 bytes. The 900 MiB trigger remains a quota safety stop.

A 565-byte fixture `test.apk` and its otherwise-empty repository-binary release were removed through the Storage API and service-side cleanup. The live catalog's real APKs remain pending central signing. APK package identity and version metadata are extracted by v15 for valid source APKs. Do not claim Android installability until a real APK is signed and verified.

## Signing: catalog APKs verified; device test remains

The original Android keystore is unavailable. A new RSA PKCS#12 signing kit exists at `/home/user/AEM/AEM-Signing-Kit.zip`, with its current secret values in `/home/user/AEM/AEM-Signing-Secrets.txt`; both files are Git-ignored. The newly generated key is **different from any values the user may have entered earlier** and will not update APKs signed by the old certificate.

The owner had already installed the GitHub Actions repository secrets from the current secrets document: `AEM_KEYSTORE_BASE64`, `AEM_KEYSTORE_PASSWORD`, `AEM_KEY_ALIAS`, and `AEM_KEY_PASSWORD`. Do not ask the owner to add them again or place the keystore secrets in Supabase. Workflow run `45005131734` completed successfully: key configuration, OIDC authentication, claiming and signing all succeeded. Database verification shows all 14 current APK artifacts have `signing_status=ready`, `signing_authority=aem`, and one shared certificate fingerprint; AEM Store versions v0.2.57 and v0.2.24 are both ready under `com.aem.store`. The original signing key is still unavailable; the replacement key cannot update apps installed from old-key APKs. Keep the signing kit backup private and never paste secret values in chat.

## Destination endpoints and application changes

The web and Android clients and the publishing/signing workflows were changed from the former Supabase project URL to the destination. The public client uses the destination publishable key; no service-role key is shipped to clients.

All destination functions below are ACTIVE and have JWT verification off, so retain their application-level checks:

- `aem-sync-github` v15 — discovery, APK manifest validation, current/previous APK retention, and APK/EXE indexing.
- `aem-android-signing` v2 — GitHub Actions OIDC and signing API.
- `aem-trigger-android-signing` v2 — sync-secret validation and separate dispatch token.
- `aem-publish-github-artifact` v2 — AEM APK publishing/upload gateway.

Runtime tests confirmed these functions start after removing a JSR declaration import that caused `BOOT_ERROR` in this project. Sync-secret authentication and expected missing-metadata/OIDC rejection paths were exercised. The new signer and publisher have not completed an end-to-end artifact workflow.

The revised in-app inbox focuses on release/update and security/withdrawal alerts, removes download-progress noise, and gives its toggle and associated-app action a purpose. The app detail view now exposes integrity-hashed Windows EXE downloads as a distinct platform section for desktop users. Changes are in `src/App.tsx`, `src/services/notifications/contract.ts`, `src/services/downloads/manager.ts`, and `src/enhanced.css`.

## Validation still outstanding

- `git diff --check` passed.
- `npm run typecheck` passed after installing locked dependencies.
- `npm run test:unit` passed: 60 tests.
- `esbuild` transpile checks passed for the sync and signing Edge Function sources.
- The fully completed discovery check is recorded in `source_sync_state` (`success`, 10 scanned, 4 new app rows, 7 releases, 21 artifacts). Future scans continue via the five-minute cron.
- The full GitHub Actions signing workflow passed in run `45005131734`, and all 14 database APK artifacts are `ready` under the replacement key. The owner should now test install/update behavior on a target Android device; old-key installed apps cannot update across the certificate change without uninstall/reinstall.
- `AEM-Signing-Kit.zip` and `AEM-Signing-Secrets.txt` are ignored and must never be staged.

## Windows package discovery work (not deployed)

The OEA `oea-laptop-latest` release includes `OEA-laptop-windows.zip`, which is an Android-on-laptop setup bundle, **not** the separate native OEA Desktop EXE. That separate EXE is currently only in large, expiring GitHub Actions archives from non-default-branch runs; the Edge sync's bounded importer intentionally cannot import it. EMA's Windows workflow builds a PyInstaller onedir bundle: the two historical EMA EXE rows in the live catalog are incomplete without their adjacent files and must not be treated as working standalone installers. Do not delete the stored files or claim that the EMA/OEA native installer problem is resolved.

This branch adds opt-in discovery of public Windows-labelled release ZIPs with GitHub SHA-256 metadata and displays them as manual downloads rather than native installers. Workflow ZIPs and arbitrary repository ZIPs are not automatically classified; ZIPs from private repositories still need a safe publishing path. New workflow scanning skips detected PyInstaller onedir executables rather than importing them alone. This does not repair existing rows or provide EMA's complete archive. The deployed sync function has not been replaced because its full source could not be compared safely, and no live ZIP row has been inserted: mutable release URLs must be kept in sync with their hash. Deploy and validate a safe sync update and release a new desktop client before expecting the manual ZIP to appear. A separate bounded background publisher, or a complete versioned public release asset from each source repository, is still needed for EMA and OEA native Windows builds.

## Download timestamps and oversized APK links (working branch only)

Download history now labels the attempt's start separately from Android's installation-confirmation time; active downloads may show an approximate remaining time when size and speed are known. Times use the device's local timezone. A failed/cancelled attempt is not assigned a fabricated completion time. EXE links opened in an external browser are not tracked as AEM-managed downloads.

Public release APKs above 50 MiB and up to 200 MiB can already be linked directly rather than copied to Storage. The local sync change hashes the downloaded source bytes, rejects a mismatch with GitHub's SHA-256, and explicitly marks the item as source-signed. This is not a cryptographic APK signature verification: Android still validates it at install, and an update requires the installed signing key. EMA's live 113,793,355-byte source-signed GitHub APK is an existing example; its certificate is not recorded. A direct link avoids Storage quota, not the Edge worker's memory or verification limits. For public release APKs over 200 MiB the working branch now attempts bounded HTTP range inspection of the manifest and signing-block markers; a GitHub SHA-256 is required and the device checks the downloaded bytes. This supports classic ZIP files below 4 GiB when the download host supports byte ranges; it does not cryptographically verify the APK signature at discovery. It has mock-based tests, not a live end-to-end production test. Private release assets without an anonymous URL and Actions archives still need a tested background publisher and durable public hosting. These changes are not deployed.

The working-branch client also suppresses the two known incomplete EMA onedir executables from the historical workflow artifact and explains why they are unavailable. Existing installed clients still see those old rows until a client update or separate server-side change. No database rows were removed.

## GitHub-backed downloads — live gateway, sync still undeployed

Migration `20261127215143_github_download_sources` is applied. `aem-github-download` is active (v4, `verify_jwt=false`) and only redirects catalogued, ready artifacts from published releases; a GitHub credential stays server-side. The owner accepts public downloads from private repositories. Actions artifacts expire and their catalog records carry an expiry. The gateway was checked using an invalid ID (HTTP 400) and a single-byte Range request through PostgreSQL pg_net: the EMA ZIP returned HTTP 206, one byte. This is not a full-download hash or Windows execution test.

EMA's successful main-branch `EMA-Windows-x64` archive (artifact 14909777427, catalog artifact 1015, expires 2026-12-08 10:18:46 UTC) is registered as a complete ZIP at the gateway. The existing desktop client does not display ZIPs; the working-branch client does. Historical isolated EXE rows remain, but the new client filters them. A GitHub API SHA-256 is shown for the ZIP; manual downloads are not automatically checked by AEM.

The local sync now indexes qualifying complete Windows archives from successful default-branch workflow runs and can point oversized private release APKs at the gateway after bounded metadata inspection. Sync changes are not deployed; live parity with deployed sync is still unverified. The separate native OEA desktop archive is only in PR-branch workflow runs and must not be silently promoted as a main release. A dispatch of the OEA desktop workflow on main was rejected by the GitHub integration with HTTP 403; GitHub access to OEA Actions needs attention. The ZIPs expire and do not constitute durable releases. The new APK and UI paths have not had end-to-end device validation.

## Direct EXE delivery and EMA packaging (working branch, not published)

The owner prefers direct EXE downloads, like AEM and mayobuild, rather than manual ZIP extraction. For a public GitHub release EXE the sync already indexes its GitHub URL and SHA-256 without storing the binary in Supabase Storage. The working branch extends this pattern to private release EXEs above 50 MiB: the service-side gateway resolves the specific GitHub asset using a server-held credential, and the catalog stores only the gateway link and digest. The owner intentionally makes catalogued private artifacts downloadable. This requires deployment of the revised sync and verification with a real private release asset; it does not convert a workflow ZIP into an EXE.

`scripts/package-ema.mjs` prepares a single NSIS installer from EMA's *complete* Windows onedir build. It refuses the known incomplete standalone EXE and checks that the worker and both support directories exist; the existing NSIS template copies the entire distribution. It requires Windows, NSIS and `npm run build:electron`. It has not yet been built or run on Windows, signed, published to a GitHub release, or linked in the catalog. A Windows CI publisher using a reviewed source build and tests is still required before claiming EMA is available as a one-click EXE. OEA already builds native EXEs but currently has no successful main-branch desktop artifact or public release; the GitHub integration returned HTTP 403 when asked to dispatch its workflow. Do not promote the PR artifacts without reviewing and building main. Neither issue is fixed merely by changing the Supabase limit.
