# Direct APK distribution through GitHub Releases

AEM can publish an already-signed APK using its GitHub Releases URL as the artifact's `download_url`. The APK binary is **not copied to Supabase Storage**, so the Supabase Free 50 MB Storage upload limit does not apply to this distribution path. AEM's catalogue metadata remains in AEM's own database.

## Edge Function

Deploy `supabase/functions/aem-publish-direct-github-release` to the **AEM Supabase project only**. Configure these server-side Edge Function secrets:

- `AEM_EXTERNAL_PUBLISH_SECRET`: a random secret with at least 32 characters, shared only by trusted publishing workflows.
- `AEM_GITHUB_TOKEN` (or the existing `GITHUB_TOKEN`): a GitHub token able to read the release and assets for the AEM-owned repository.

Do not place the publish secret in the Android app, a public web bundle, or a repository. Call the function from a trusted CI workflow/server.

## Request

POST JSON to `/functions/v1/aem-publish-direct-github-release` with:

```json
{
  "repo": "Emmanuel001afk/EMA",
  "tag": "v1.2.3",
  "filename": "ema-release.apk",
  "download_url": "https://github.com/Emmanuel001afk/EMA/releases/download/v1.2.3/ema-release.apk",
  "version_name": "1.2.3",
  "version_code": 123,
  "package_identity": "your.actual.android.package",
  "size_bytes": 73400320,
  "sha256": "64-character-sha256-of-the-apk",
  "signing_certificate_sha256": "64-character-sha256-of-the-signing-certificate",
  "channel": "stable",
  "title": "EMA 1.2.3",
  "notes": "Release notes"
}
```

Send the secret in `x-aem-external-publish-secret`. Replace every example value with real release metadata; the package identity, checksum, certificate fingerprint and byte count must come from the actual signed APK/build. GitHub must confirm the release is published and the URL, asset filename, and size match. If GitHub provides an asset SHA-256 digest, AEM also checks it against the supplied checksum.

The APK must already be signed with the source app's intended signing key. This path records the source signing fingerprint and marks the artifact ready; it does not re-sign APKs. If an APK needs AEM's central signing, continue using the existing Storage-based signing path or move the signing step into the source repository's trusted CI before publishing the Release asset.

## Limits and security

- The URL must be the exact HTTPS GitHub Release asset URL for a release in a repository owned by `Emmanuel001afk`; arbitrary URLs are rejected.
- Only an already-registered AEM GitHub catalogue entry can publish through this endpoint.
- The source APK remains hosted by GitHub Releases. If the release/asset is deleted or made inaccessible, AEM's download link will stop working.
- This path avoids the Supabase Storage file-size limit, but not GitHub's own release/storage policies or download availability.
- This code change does not deploy the Edge Function or change the live AEM database by itself.
