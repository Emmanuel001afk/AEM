# AEM destination Supabase setup — current handoff

Updated 2026-11-22. This records observed setup and remaining limitations. No secret values belong in this file, Git, or chat.

## Destination and storage safety

- Supabase org AEO (`tzqhxxbljvumijeejzfy`), project AEM (`zaaauldrktvytskerpmc`), region `eu-west-1`.
- No historical database rows or Storage objects were transferred. The destination bucket was empty before the controlled discovery test.
- `aem_functional_core_bootstrap` created the ten AEM public tables, policies/RLS, triggers/RPCs, `aem-artifacts`, and `pgcrypto`, `pg_net`, `pg_cron`.
- `aem_storage_budget_guard` and `aem_service_role_table_grants` are applied. A database trigger rejects new/replaced `aem-artifacts` objects once the bucket would exceed 900 MiB, reserving about 100 MiB under the stated 1 GiB allowance. Service-role SQL grants were necessary for Edge Function writes.
- Latest readback after retention cleanup: 15 Storage objects / 142,268,566 bytes. The 900 MiB guard prevents quota overrun; the deployed sync also prunes obsolete APK objects via the Storage API.
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

## Signing: required owner action

The original Android keystore is unavailable. A new RSA PKCS#12 signing kit exists at `/home/user/AEM/AEM-Signing-Kit.zip`, with its current secret values in `/home/user/AEM/AEM-Signing-Secrets.txt`; both files are Git-ignored. The newly generated key is **different from any values the user may have entered earlier** and will not update APKs signed by the old certificate.

The owner reports these GitHub Actions repository secrets were already installed from the current secrets document: `AEM_KEYSTORE_BASE64`, `AEM_KEYSTORE_PASSWORD`, `AEM_KEY_ALIAS`, and `AEM_KEY_PASSWORD`. A later workflow run (`45003739840`) confirms the `Configure AEM signing key` step succeeded, including base64 decoding; do not ask the owner to add them again or add the keystore secrets to Supabase. That run reached `Get GitHub OIDC token` successfully and then failed in `Sign pending AEM Android APKs` while claiming/signing artifacts. GitHub log retrieval returned EOF, so the precise request error is not yet known. A successful end-to-end signing run remains outstanding; investigate the Supabase claim/OIDC path and workflow logs, not secret setup. Do not paste secret values in chat.

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
- GitHub Actions signing secrets are installed; workflow run `45003739840` confirms key configuration and OIDC token retrieval passed, but the signing/claim step failed. Diagnose that gateway call and then complete a real signing/install test before saying the Android migration is fully ready.
- `AEM-Signing-Kit.zip` and `AEM-Signing-Secrets.txt` are ignored and must never be staged.
