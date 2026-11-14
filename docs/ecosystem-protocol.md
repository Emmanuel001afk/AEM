# AEM-side ecosystem capability contract

`src/domain/ecosystem.ts` defines versioned registrations for AEM Store, EMA, OEA, Phormi and Central Hub, device identity, exposed capabilities, scoped grants, expiry and revocation. Pure authorization tests cover denial of ungranted, expired, revoked and mismatched peer/device requests.

**This is protocol preparation, not connected-app integration.** No partner repository, identity or database has been changed. No discovery advertisement establishes trust. Before this contract can be exposed over a network or Android intent interface, an implementation must:

1. authenticate a stable peer/device key using an explicitly approved pairing;
2. keep private keys in Android Keystore/Windows secure storage;
3. persist user-approved per-device/per-capability grants independently in AEM;
4. authenticate requests, enforce expiry/revocation, bind payload integrity, reject replayed request IDs, rate-limit and audit requests;
5. require the relevant local consent again for installation, screen/input sharing and transfer acceptance;
6. use independent app-owned APIs, never query or merge another app's database.

AEM does not yet have that partner transport or grant-management UI. All external capability use remains unavailable. A future LAN protocol should use a separate version from Android's existing Wi-Fi Direct protocol 6; do not retrofit unencrypted sender tokens into a claim of cryptographic identity.

## LAN transfer work remaining

The current Android Wi-Fi Direct channel's consent, integrity, offsets and history remain intact. Desktop ADB is a separate explicit fallback. A complete AEM-to-AEM LAN implementation still needs Android NSD / desktop mDNS, pinned-key encrypted transport, out-of-band pairing verification, revocation, receiving consent on both platforms, range/offset persistence, disk quota checks, SHA-256 finalization and bidirectional physical tests. Discovery data must be treated as untrusted, and interrupted/unverified bytes must never become installable packages.
