> Three separate local channels. For the generic desktop ↔ phone/browser HTTPS companion, see
> [LAN transfer](lan-transfer.md); for AEM desktop ↔ AEM desktop pairing, see
> [PC-to-PC transfer](pc-transfer.md). The Android Wi-Fi Direct protocol described below is separate and
> unchanged: it never shares a port, token format or consent flow with either PC channel.

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

1. Pick items. The app picker lists user-installed apps (plus updated system
   apps), loads icons in the background, and pages results to keep memory use down on Android Go/low-RAM
   phones. Media thumbnails use a two-worker queue and a heap-sized cache that
   trims under memory pressure. A single-APK app is selected from its installed APK directly (no
   staging copy); split apps are wrapped in a cached `.apks` bundle using ZIP's
   no-compression mode, because APKs are already ZIP files. Files, media and
   folders are read through the Storage Access Framework. Folders keep their
   relative structure.
2. **Send** requests the Nearby devices permission (Android 13+) or fine
   location (Android 12 and below), checks Wi-Fi and (below Android 13) Location
   mode, then starts discovery.
3. The sender advertises nothing; it searches for `_aemtransfer._tcp` DNS-SD
   records. Only records with `role=receiver` and a session token are valid Send
   targets. If Android reports a generic Wi-Fi Direct peer first, it remains a
   non-actionable “Waiting” row until AEM receives that authenticated record.
   The sender keeps service discovery separate from peer scans because the
   current AEM handshake cannot securely send without the receiver token.
4. Selecting a receiver stops peer discovery and removes the DNS-SD service
   request through Android's completion callbacks before setting
   `groupOwnerIntent = 0` and connecting. A short settle delay prevents the final
   discovery operation from racing group negotiation. If Android returns
   `WifiP2pManager.BUSY` (reason 2), AEM clears discovery, removes a stale group,
   and retries twice before showing a reason-specific error. “Busy” is not
   reported as a distance problem. Once the group forms, the sender opens the
   receiver's TCP server on port **38177**.
5. The receiver shows an **Incoming transfer** dialog with the sender name, item
   count and size. Decline is reported to the sender as a first-class result and
   is never retried.

The connection stays open after a transfer so more items can be sent without
reconnecting. **Disconnect** closes the group.

## Timing boundaries and diagnostics

A selected app is prepared before the Wi-Fi transfer starts. Single-APK apps use
the installed APK directly; split apps are wrapped once in a cached `.apks`
archive. `installed_apps_ready` measures the picker scan; `app_prepare_*`
events measure the selected app's queueing and preparation, not discovery or
sending. Wi-Fi Direct discovery has `sender_service_request_*`,
`sender_service_discovery_*`, and `sender_receiver_record` events; group setup
has `sender_p2p_*` events. `sender_receiver_decision.wait_ms` includes the time
the receiver's person takes to accept the request, so it is not payload time.

`sender_payload_complete` measures the sender reading and hashing its source
while writing bytes to the socket. After that, the sender waits for
`sender_final_ack`: the receiver still verifies and saves the bytes before
acknowledging. The UI labels this **Verifying received files**. Receiver-side
`receiver_group_ready` / `receiver_service_advertised` / `receiver_server_listening`
events confirm setup; `receiver_socket_accepted`,
`receiver_handshake_validated` and `receiver_connection_failed` show how far a
sender got. `receiver_file_saved` and `receiver_transfer_verified` report
receive/save work. Its streaming SHA-256 check avoids a second full-file disk
read after a normal transfer. This receiver finalization is part of transfer completion;
Android's package extraction and installation happen only later, after the user
taps Install, and are separately reported as `receiver_install_*` events.

For a repro with USB debugging enabled, capture the filtered log immediately
after the delay or force-close:

```sh
adb logcat -d -v time -s AEM_TRANSFER_TIMING:I AEM_TRANSFER:W AndroidRuntime:E ActivityTaskManager:E
```

`AEM_TRANSFER_TIMING` contains duration/size/stage data and does not include
app labels, package names or session tokens. Include the `FATAL EXCEPTION` /
`AndroidRuntime` lines around a force-close; those contain the exception and
stack needed to confirm a crash root cause.

For a directional-send failure, capture this log on **both** phones. On the
Tecno sender, no `sender_dns_service_seen` after successful service-discovery
requests points to discovery/advertisement; a service event without
`sender_receiver_record` points to TXT parsing/metadata (and
`sender_receiver_record_invalid` specifically means the token was absent). A receiver record
without `sender_p2p_link_ready` or with `sender_p2p_link_failed` points to group
negotiation; a ready P2P link without `sender_socket_connected` points to the
TCP route/server; a connected socket followed by `receiver_connection_failed`
points to the receiver-side protocol/transfer stage. A generic “Waiting” peer
has no receiver token and is intentionally not a valid Send target.

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
- Split-app exports: `cache/aem-apps` (fingerprint-cached `.apks` bundles; single APKs stream from their installed package path without a duplicate cache copy)
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

## Permissions and discovery (Tecno Spark 3 ↔ Infinix Smart 8)

- **Infinix Smart 8 (Android 13 Go, XOS)**: needs `NEARBY_WIFI_DEVICES` (`neverForLocation`). Grant when AEM asks. `Location` does **not** need to be on.
- **Tecno Spark 3 (Android 12 and below, HiOS)**: needs `ACCESS_FINE_LOCATION` **and** Location mode ON (quick-settings tile). Without it Android returns an empty discovery result even if Wi-Fi is on. AEM now shows a dedicated "Location is off" card with an action to open settings.
- Wi-Fi must be ON on both phones, but they do not need to be on the same Wi-Fi network — Wi-Fi Direct builds its own group. Keep both screens on, <1 m apart, battery saver off.
- XOS/HiOS can delay the first DNS-SD advertisement 5–15 s. AEM retries service discovery every ~2.8 s and falls back to legacy Wi-Fi Direct peer list (`WIFI_P2P_PEERS_CHANGED_ACTION`) so a device still appears as "Wi-Fi Direct device" even if the TXT record is delayed.

## Receive vs Send and reversal

- Only the **receiver** advertises `_aemtransfer._tcp` with `role=receiver`. The sender discovers; this is why Send scans only after Receive is listening.
- `Send` can now scan even with zero items selected so you can test visibility without picking files first — the actual connection is still gated until you pick something.
- The Wi-Fi Direct group is owned by the receiver on port **38177**. To reverse direction without a full repair, use **Swap** (sender → "Swap & Receive", receiver → "Swap → Send") which tears down the group and switches roles in one tap. Disconnect fully also leaves a clean state.

## Active downloads and progress

- Banner progress is global. **Downloads** now also shows an **Active receives** card while a transfer is in-flight (sender, count, bytes, %) and a **Resume available** card when `.part` files remain in `.resume/`.
- Resume: interrupted transfers keep `.part` offsets; a retry re-uses the transfer ID and sender skips already-verified bytes. If the acknowledgement is lost, the receiver treats the same `(id, signature)` as already done.

## Desktop and phone↔PC

Current branch: Devices provides explicit Android-authorized ADB discovery, verified push/pull and accessible base/split APK export. File progress is per-item/stage, not a fabricated byte rate. Interrupted ADB copies require retry. It is **not** the planned AEM LAN service, and no physical transfer has been tested here. The existing protocol-6 Android Wi-Fi Direct code is preserved.

### Historical desktop state

- The desktop **Transfer** tab runs the separate application-neutral HTTPS companion described in [LAN transfer](lan-transfer.md). Any compatible browser can pair with explicit consent and exchange verified files. Native Android Wi-Fi Direct remains separate on port 38177.
- The companion uses an ephemeral HTTPS port and optional mDNS advertisement, not the old proposed UDP 38178/TCP 38179 protocol. Uploads resume after interruption within the server session; browser downloads resume only while their tab remains open. No Android protocol-6 compatibility is claimed.
- The ordinary non-desktop web Store retains its Android transfer explainer. Devices offers authorized ADB file transfer and split export as an independent route.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| "Wi-Fi Direct is busy" | Another app owns a P2P group. Toggle Wi-Fi and retry. |
| Receiver missing from the list | Confirm the intended receiving phone shows **Receive → Listening**, keep Location on and permission granted on pre-Android 13 phones, wait 10 seconds, then rescan. A generic “Waiting” peer means Android has not delivered the AEM receiver record/token yet; it cannot be used to send. |
| Tecno Spark 3 sees nothing next to Infinix | On Tecno: Location ON + Location permission granted (Android 8–12); on Infinix: Nearby permission granted (Android 13+); one phone Receive listening, other Send scanning; <1 m apart. |
| One direction works, the other does not | The phone that should receive must be on **Receive → Listening**. Only the receiver advertises. If the modes are correct, capture timing logs from both devices and identify the last sender stage reached. |
| Connection fails immediately | Check `sender_p2p_link_*` versus `sender_socket_connected` in the Tecno log to separate group negotiation from the TCP route; keep the phones close, and retry after disabling battery saver. |
| "Different AEM version" | Both phones must run a build with protocol 6. |
| Install button opens Settings | Android's "install unknown apps" permission has not been granted for AEM. |
| Transfer stops when leaving | Both devices must keep the transfer screen alive; receive sessions survive in the background via the foreground service. |
| Progress reaches 100% but completion pauses | The sender is waiting for the receiver to verify/save the received bytes and return its final acknowledgement; this is not APK installation. See `sender_final_ack` in the timing logs. |
| AEM closes on Tecno Spark 3 | Capture `AndroidRuntime`/`FATAL EXCEPTION` logs with the diagnostic command above. The app now bounds thumbnail workers/cache on low-memory devices, but a device-specific crash is not confirmed without its stack trace. |
| Progress not in Downloads | Active receives now show at top of Downloads; banner also shows % + speed. Partial `.part` kept for resume. |
