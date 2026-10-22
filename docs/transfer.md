# AEM Transfer

AEM Transfer moves files directly between two Android phones over a Wi-Fi Direct
link. There is no upload, no Supabase row and no internet requirement. The only
participants are the two devices, and both must agree before a byte of file data
is sent.

The screen is part of the Store experience: it uses the same dark radial
backdrop, red accent (`#F04444`), 20–22 dp card radii, eyebrow labels, type
scale and section navigation as the rest of AEM. The web client shows a matching
"Local transfer" explainer instead of pretending a browser can start the link.

## Screen map

| Section | What it does |
| --- | --- |
| **Transfer** | Send/Receive modes, the device name, category chips (Apps, Photos, Videos, Music, Files), search, and the fixed selection bar. |
| **Downloads** | Files received on this phone, with Open/Install, Share and Delete. |
| **History** | SENT / RECEIVED / INSTALLED / FAILED / DECLINED rows, kept on-device. |

A persistent strip under the header carries live state: scanning, connecting,
transfer progress (with speed), success and errors. Errors always offer the next
action (retry, open settings, open downloads) instead of a dead status line.

## Send flow

1. Pick items. Apps are exported from the installed APK/split set into a cached
   `.apks` bundle. Files, media and folders are read through the Storage Access
   Framework. Folders keep their relative structure.
2. **Send** requests the Nearby devices permission (Android 13+) or fine
   location (Android 12 and below), checks Wi-Fi and (below Android 13) Location
   mode, then starts discovery.
3. The sender advertises nothing; it discovers `_aemtransfer._tcp` DNS-SD
   records. Only records with `role=receiver` and a session token are listed, so
   unrelated Wi-Fi Direct peers never appear as fake receivers.
4. Selecting a receiver sets `groupOwnerIntent = 0`, connects, and opens the
   receiver's TCP server on port **38177**.
5. The receiver shows an **Incoming transfer** dialog with the sender name, item
   count and size. Decline is reported to the sender as a first-class result and
   is never retried.

The connection stays open after a transfer so more items can be sent without
reconnecting. **Disconnect** closes the group.

## Receive flow

1. **Start receiving** binds the local server, creates the Wi-Fi Direct group
   (the receiver is the group owner) and advertises the DNS-SD record with a
   fresh 32-character session token.
2. A foreground service keeps the receive session alive when AEM is backgrounded
   and shows a live notification that opens Transfer.
3. Every incoming connection must present the current session token and a
   non-empty sender token. Files then wait for explicit acceptance.
4. Received files are written as `.part` files under
   `Downloads/AEM Transfer/.resume/`, verified, and moved into
   `Downloads/AEM Transfer/`. Duplicate names become `name (1).ext`.

**Stop receiving** removes the DNS-SD record, tears down the group, closes the
server and stops the service.

## Wire protocol (version 6)

All values are big-endian. Strings use `DataOutputStream.writeUTF`.

```
sender → receiver
  int32   protocol = 6
  utf     transferId            (UUID, [A-Za-z0-9-]{8,64})
  utf     senderName
  utf     receiverToken         (from the DNS-SD TXT record)
  utf     senderToken
  int32   itemCount             (1..2000)
  int64   totalBytes
  repeat itemCount:
    int32   nameLength          (1..16000 bytes, UTF-8)
    bytes   relativePath
    int64   size                (0..50 GiB)

receiver → sender
  int32   accepted              (1 = accepted, 0 = declined)
  int64   offsets[itemCount]    (bytes already on disk; <= size)

sender → receiver
  repeat for every item with offset < size:
    bytes   file payload from offset
    bytes   SHA-256 of the full file (32 bytes)

receiver → sender
  int32   result                (1 = verified, 0 = failed)
```

Notes:

- A retry reuses the transfer id and the receiver re-computes offsets, so an
  interrupted transfer resumes instead of restarting.
- If the final acknowledgement is lost, the retried transfer id and item
  signature match the last completed transfer; the receiver reports every item
  as already complete and the sender skips the payload. No duplicate files.
- Zero-byte files are created explicitly; no digest is exchanged for them.
- A sender retries transient network failures three times. A decline is fatal.

## Security and trust

- A transfer requires the receiver's session token, which is only advertised
  while Receive is active.
- The receiver must accept the sender's request. The dialog shows the claimed
  sender name, item count and total size.
- Paths are sanitised (separators normalised, `..`, control characters and
  Windows-reserved characters removed), so an archive-style path cannot escape
  the destination folder.
- Every file is SHA-256 verified before it is moved into place.
- Counts, names, per-item sizes and total size are bounded before any allocation
  or write.
- APK installs go through `PackageInstaller`; AEM cannot bypass Android's
  confirmation or the "Install unknown apps" permission.
- The link is local and unencrypted at the application layer. Wi-Fi Direct itself
  is a point-to-point link, but the app does not add a second encryption layer;
  treat it as a nearby-device transfer, not as a replacement for a secure
  messaging app.

## Permissions

| Version | Permission |
| --- | --- |
| Android 13+ | `NEARBY_WIFI_DEVICES` (`neverForLocation`), optional `POST_NOTIFICATIONS` |
| Android 6–12 | `ACCESS_FINE_LOCATION` / `ACCESS_COARSE_LOCATION`, Location mode on |
| Media list | `READ_MEDIA_IMAGES` / `READ_MEDIA_VIDEO` / `READ_MEDIA_AUDIO` (33+) or `READ_EXTERNAL_STORAGE` (≤32) |
| Installs | `REQUEST_INSTALL_PACKAGES` + the system "install unknown apps" toggle |
| Service | `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_DATA_SYNC` |

Location is deliberately **not** required on Android 13 and newer: the manifest
declares `NEARBY_WIFI_DEVICES` with `neverForLocation`.

## Storage

- Received files: `getExternalFilesDir(DIRECTORY_DOWNLOADS)/AEM Transfer`
- Resume state: `.../AEM Transfer/.resume` (cleaned after 7 days)
- App exports: `cache/aem-apps` (fingerprint-cached)
- Picked files without a provider size: `cache/aem-picked`
- Install staging: `cache/aem-install-*` (deleted after the session is opened)
- History and the device name: `SharedPreferences` (`aem_transfer`)

The FileProvider exposes the received-files folder and the app-export cache, so
Open/Share work with Android's viewer and chooser.

## Integration points

The Android build in `.github/workflows/aem-android-final.yml` copies the native
sources into the Capacitor project and runs
`native/patch_android_manifest.py`, which:

- adds the transfer permissions (including `POST_NOTIFICATIONS`),
- declares `AemTransferActivity` with `singleTop` and
  `configChanges="orientation|screenSize|smallestScreenSize|keyboardHidden|uiMode"`
  so a rotation or re-entry cannot kill an active transfer,
- declares `AemTransferService` as a `dataSync` foreground service,
- installs the AEM FileProvider paths and the monochrome notification icon.

The web client opens the activity through the `AemTransfer` Capacitor plugin and
always passes the current appearance so native and web stay in the same theme.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| "Wi-Fi Direct is busy" | Another app owns a P2P group. Toggle Wi-Fi and retry. |
| Receiver missing from the list | The other phone hasn't tapped **Start receiving**, or the app version differs (protocol 6). |
| Connection fails immediately | The phones are too far apart or the group owner role flipped; scan again. |
| "Different AEM version" | Both phones must run a build with protocol 6. |
| Install button opens Settings | Android's "install unknown apps" permission has not been granted for AEM. |
| Transfer stops when leaving | Both devices must keep the transfer screen alive; receive sessions survive in the background via the foreground service. |
