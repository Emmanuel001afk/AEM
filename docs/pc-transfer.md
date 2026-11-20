# AEM PC ↔ PC transfer — `aem-peer/1`

Two computers running AEM Store move files to each other directly on the local network. No server, no
upload, no account, no Supabase row and nothing is executed or installed by this channel. It sits beside
two other channels and never merges with them:

| Channel | Protocol | Peers | Where it lives |
| --- | --- | --- | --- |
| AEM PC ↔ AEM PC | `aem-peer/1` | two AEM desktop installs | this document, `electron/transfer/peer.ts` |
| Phone / tablet / browser ↔ PC | `aem-lan/1` | any browser on the LAN | [lan-transfer.md](lan-transfer.md) |
| Android phone ↔ Android phone | Wi-Fi Direct protocol 6 | two Android devices | [transfer.md](transfer.md), `native/AemTransferActivity.java` |

The PC channel has its own port, its own trust store and its own consent prompts. It never accepts an
`aem-lan/1` bearer token or a protocol 6 session token, and it does not serve the browser companion's
HTML/JS assets — an unpaired or unauthenticated request gets `401` before it can learn which routes exist.

## Use

**Transfer → AEM PC ↔ AEM PC** on both computers.

1. Press **START PC-TO-PC SHARING** on each PC. AEM confirms with a native dialog; Windows Firewall will
   ask once — allow it on **private** networks only and never forward this port through a router.
2. On the receiving side (either PC, it works both ways) press **NEW INVITATION**. The code is valid five
   minutes, works once, and is the pairing credential: hand it over a channel you already trust (a
   messenger chat you can see on both screens, a QR screenshot, a USB stick), never a public channel.
3. Paste the other PC's code into **Pair with an invitation from another PC** and press **PAIR**.
4. Both PCs now show a native consent dialog with the same **6-digit confirmation code** and the other
   PC's certificate SHA-256. Approve only if both codes match, then reject/unpair if they did not.
   The peer label is a user-declared description, not a verified identity.
5. Press **SEND FILES…** on a paired PC, pick up to 16 files, and approve **Receive this file?** on the
   other PC. Received files are written to `Downloads/AEM Transfer` with the transfer id as a prefix and
   only after the whole-file hash matches. A partial file sits under `.pending` and is never listable,
   installable or fetchable by anyone else.
6. **OPEN RECEIVED FILES** opens that folder; **History** lists what this PC sent, received, refused or
   lost, on this PC only.

Pairing survives a restart (the identity key and the peer list are stored in this PC's user profile), and a
restarting PC announces its new port to already-paired PCs. Unfinished transfers deliberately do **not**
survive a stop or restart: press **RESUME** on the sending PC while both are running instead.

## Wire format

HTTPS on an ephemeral port, TLS 1.2+, HTTP/1.1, one 1 MiB chunk per request. Both PCs present the same
self-signed identity certificate in the TLS handshake (server and client), and every peer verifies the
peer certificate it sees against the pinned one it stored at pairing time.

```
GET  /peer/hello                     public presence: id, name, fingerprint, port, limits
POST /peer/pair                      header X-AEM-Peer-Invite: <invitation token>
                                     body {id,name,cert,nonce,host,port} → 200 {id,name,cert,port,nonce,sas}
```

Everything else is signed. A paired PC signs each request with the key derived at pairing time:

```
X-AEM-Peer-Auth: mac=<hex>; from=<sender device id>; ts=<ms>; nonce=<32 hex>
mac = HMAC-SHA256(pairSecret, "v1\n" + METHOD + "\n" + pathWithQuery + "\n" +
                  sha256(body) + "\n" + from + "\n" + ts + "\n" + nonce)
```

`pairSecret = HKDF-SHA256(ikm: invitation token, salt: both certificate fingerprints + both pairing nonces,
info: "aem-peer/1 v1")`, so a re-used or replayed invitation can never re-create a previous session key.
Requests outside a ±120 s window, with an unknown signer, with a bad MAC, or with a nonce already seen from
that peer are refused. Signed routes:

- `GET /peer/state` — this peer's own rows. `GET /peer/transfers/<id>` — committed offset/state of one row.
- `POST /peer/transfers` — manifest `{id,name,size,sha256,device}`. The same manifest returns the
  committed `{id,offset,state}` (that *is* the resume mechanism); the same id with a different manifest is
  `409`; a re-offer of a declined transfer is `403`, so a refusal is never retried into an argument.
- `PATCH /peer/transfers/<id>?offset=<n>` — one raw ≤1 MiB chunk with `X-Chunk-Sha256`. The receiver re-reads
  its own file size and refuses unless `offset` equals it, so an interrupted sender can never double-commit
  or skip bytes. A chunk hash mismatch is `422` and commits nothing.
- `POST /peer/transfers/<id>/complete` — full-file SHA-256 plus exact length, then an atomic rename out of
  `.pending`. A mismatch truncates the partial back to zero and answers `422`; there is no path where an
  unverified file becomes visible. Completion is idempotent.
- `POST /peer/transfers/<id>/cancel` — drop the row and its partial; later requests for that id answer `410`.

`X-AEM-Port` lets each side keep the other's current port. mDNS advertises and browses
`_aem-peer._tcp` with TXT `protocol=aem-peer/1`, `id`, `name`, `fp` for the "advertised on this network"
list — advertisement is discovery only, never authorization: a discovered PC still needs an invitation
code, the pinned fingerprint check and a consent dialog on both ends.

## Limits

Per file 4 GiB · chunk 1 MiB · 32 GiB received per session · 64 queued rows · 8 peers · 16 files per send
· 2 GiB free space kept on the destination volume · one consent prompt per peer at a time
(offers never stack dialogs, and a declined or finished row never wedges the queue) · 6 pairing
attempts per address per minute · 4 KiB JSON bodies · responses capped at 512 KiB by the
requester · a 180 s idle timeout on both ends, so a file prompt may be read for up to three minutes
before the sender reports it as interrupted (press **RESUME**; the receiver keeps what it committed). Filenames are single-segment and Windows-safe: `..`, `/`, `\`,
`<>:"|?*`, control characters, trailing dots/spaces and `CON`/`PRN`/`AUX`/`NUL`/`COM1-9`/`LPT1-9` are
refused with `400` before any prompt appears. Received rows are named
`<transferId>-<name>`, so no destination path can ever be chosen by the sender and nothing is overwritten.

## Security model, honestly

- **What an off-path LAN attacker gets:** nothing. Requests need the pairwise key *and* a TLS client
  certificate matching the pinned one; the invitation is 256-bit, single-use and rate-limited.
- **What a same-LAN attacker who steals an invitation code gets:** a pairing *request*. Both PCs still have
  to approve, and the pinned fingerprint plus the confirmation code come from this PC's own view of the
  TLS session, so a relay only works if it also defeats the code comparison the user is told to do.
- **What the shared code is not:** a key exchange against a determined on-path attacker who controls the
  network *and* can produce a certificate whose fingerprint the victim pasted. Compare the 6-digit code.
- **What pairing never grants:** installing, launching, registry or database access, screen/input control,
  arbitrary file reads, other peers' transfers, or any file this PC has not explicitly selected for sharing.
- **Malware on either PC** reads everything both sides can see, including the stored identity key and peer
  keys in this user's profile. That is the same trust boundary as any local file copy; do not pair on a
  machine you do not control.
- Both directions are hash-verified per chunk and again over the whole file. Nothing here validates
  publisher signatures, and a received APK is just bytes — installing it is a separate, explicit Store flow.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| "No LAN IPv4 address found" | This PC is on no private network. Connect, then start sharing again. |
| Pairing never arrives | Windows Firewall blocked AEM on the private network, or the two PCs are on different subnets / isolated APs ("client isolation"). |
| "Peer TLS certificate does not match the pinned fingerprint" | That PC rebuilt its identity (fresh profile, reinstalled user data) or the code came from a different machine. Unpair, then re-pair with a new invitation. |
| "outside the clock window" | The two clocks differ by more than 2 minutes. Sync both (`w32tm /resync`) — the signature window is deliberately narrow. |
| `Peer unreachable` / transfer marked failed | The other PC slept, stopped sharing or the Wi-Fi dropped. Press **RESUME** on the sending PC; it continues from the receiver's committed offset. |
| Nothing after a restart | A stopped session never resumes. Send again; the queue is per-session by design. |
| Want to revoke access | **UNPAIR** deletes the key on this PC; **STOP & DROP TRANSFERS** closes the listener and discards partials. Do both on a machine you no longer trust. |

## Evidence and open boundaries

`tests/peer.test.mjs` runs two real peer services over loopback: full bidirectional byte transfers with
hash verification and atomic saves, invitation one-use/expiry/self-pair refusal, matching confirmation
codes, replay/re-key/unknown-signer/clock-skew refusal, chunk-hash and offset smuggling, declined receives,
manifest/path rejection, oversized bodies, the consent lock, cancel/`410`, mid-transfer receiver death,
restart behaviour and identity-file permissions. These are real TLS handshakes and real file writes, not
mocked network calls.

Still requiring physical acceptance testing: two real Windows PCs across a router and a phone-hotspot
subnet, the Windows Firewall first-run prompt, sleep/resume in the middle of a multi-GB transfer, sustained
throughput on 2.4 GHz Wi-Fi, real mDNS discovery on APs that block multicast, and a reinstall of one client
(its identity key changes, so pairing must be redone).
