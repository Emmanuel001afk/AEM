# Generic local HTTPS transfer — aem-lan/1

## Use

On Windows AEM: **Transfer → Start local HTTPS**. Use a trusted private LAN and allow the application on private networks in Windows Firewall; never forward its port through a router. Open the displayed local IPv4 HTTPS address in a compatible phone, tablet or computer browser. No app brand, cloud login, Supabase or commercial service is required.

The local certificate is ephemeral and self-signed. **Compare its SHA-256 fingerprint in the other browser's certificate details against the PC before trusting it or entering the invitation.** Do not blindly dismiss certificate warnings. If that browser cannot inspect/verify the fingerprint, use the Android-authorized USB/ADB route under Devices instead. AEM does not globally disable certificate checks. New server sessions generate a different certificate.

Enter the one-use, 256-bit invitation within two minutes; the PC must approve the device label/address. Labels are unverified user descriptions, not authenticated publisher names. Each approved peer gets a separate one-hour bearer grant, stored only in browser sessionStorage and server memory. Invitations are never sent in query strings or discovery records. Revoke a peer or stop sharing to invalidate grants.

- **Phone/browser → PC:** choose a file, press Send, and approve its name/size/hash on the PC. Pause aborts the active request. Select the same file and press Send/Resume after interruption: the receiver returns its committed offset. Per-chunk and final full-file SHA-256 checks are required. Only an atomically finalized file appears in Downloads/AEM Transfer; partials remain under `.pending` and cannot be fetched/installed.
- **PC → phone/browser:** use the PC file picker to explicitly share files. On the paired browser refresh, Receive/Resume, then Save after full SHA-256 verification. Range downloads resume within the current tab. Reloading the tab loses partial download buffers; start again. Receiving a file never executes or installs it.
- Removing a completed received item from the queue does not delete the saved file. Stop/revoke removes unfinished uploads. Stop invalidates every session; resume across server restarts is intentionally unavailable.

## Bounds and discovery

256 MiB per file, 1 MiB chunks, 2 GiB receive quota per server session, 64 queued files, 8 peers, 512 MiB free-space reserve, bounded JSON, request timeouts, pairing rate limits, exact offsets, UUID destination prefixes, path/reserved-name checks and no overwrite. Files are never exposed by arbitrary pathname. Host/Origin allowlists prevent cross-origin browser requests and DNS-rebinding hostnames.

mDNS advertises `_aem-transfer._tcp` with protocol `aem-lan/1`, but advertisement is not authorization. Compatible discovery clients can use it; browsers normally use the displayed address. This is not automatic browser mDNS discovery and not Android's DNS-SD/Wi-Fi Direct protocol 6. The existing Android native phone-phone transfer remains unchanged. PC byte transfer is independent of the emulator.

## Interoperability API

All API requests use the displayed HTTPS origin after certificate verification. No external scripts/CDNs. `POST /pair` with `{invitation,name}` requires PC confirmation and returns `{token,peer,chunkBytes,maxFileBytes}`. All subsequent requests need `Authorization: Bearer <token>`.

- `GET /api/state`: only that peer's uploads and explicitly PC-shared offers.
- `POST /api/uploads` with `{name,size,sha256}`: consented new upload or existing matching `{id,offset,state}` for resume.
- `PATCH /api/uploads/<id>?offset=<n>`: raw chunk, `X-Chunk-Sha256` header; rejects stale offsets or invalid hashes.
- `POST /api/uploads/<id>/complete`: full SHA-256 and length verification, atomic finalization.
- `GET /api/offers/<id>` with `Range: bytes=start-end`: bounded range of an explicitly shared file. Client must verify final SHA-256 before saving.

None of these endpoints grants installation, app/database access or phone screen/input control. Other applications can implement the same protocol regardless of name; copying tokens or display labels is not a legitimate identity integration.

## Evidence

`tests/lan.test.mjs` performs actual loopback HTTPS transfers with certificate trust enabled, hashes real bytes, verifies interruption/retry, path rejection, peer isolation, expiry/replay, revoke, consent denial and corrupt finalization. These are not mocked network calls. `scripts/lan-browser-smoke.cjs` exercises the actual bundled browser client in Chromium with an exactly pinned test certificate; its automatic consent callback exists only in the test fixture. Physical phones, router isolation, mobile browser certificate UX, Windows firewall and reconnect after sleep still require acceptance testing.
