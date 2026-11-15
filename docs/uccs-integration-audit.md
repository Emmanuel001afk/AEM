# UCCS integration audit — AEM

**Audit status:** source-inspected; documentation only  
**Audited base:** `main` at `5ac34d0227eb1d08d80c05fb4e85face6520ea9b`  
**UCCS target:** AEO Universal Cross-Platform Coordination System, draft 0.1  
**Important:** This file records compatibility findings. It does not declare AEM UCCS-conformant and does not change runtime behavior.

## 1. Existing AEM foundation

The current AEM source already contains useful application-neutral foundations:

- `src/domain/ecosystem.ts` declares `ECOSYSTEM_PROTOCOL = 'aem-capabilities/1'`.
- `PlatformRegistration` carries a reverse-DNS `platformId`, display name, semantic version, device ID and a capability list.
- `CapabilityGrant` is scoped to peer ID, device ID and capability, with expiry and revocation.
- `authorizeCapability` checks that the request's peer/device match the authenticated transport identity and that a matching grant is active and unexpired.
- `src/domain/crossPlatform.ts` models independent platform identity, installation identity, installed state, generic capabilities, recognition requests/responses and response merging.
- `docs/ecosystem-protocol.md` explicitly says recognition is not authorization, advertisements do not grant access, and the transport must authenticate peers.
- The documented `aem-lan/1` transfer path has pairing and receive consent and avoids unattended installation, arbitrary file reads, screen control and cross-app database access.

These are reusable foundations. They should be adapted, not discarded.

## 2. UCCS compatibility mapping

| UCCS concern | Existing AEM support | Audit result |
|---|---|---|
| Independent platform identity | Reverse-DNS `platformId`; separate `appId` and device identity | Partial match |
| Generic platform recognition | Generic recognition request/response; no hard-coded brand allowlist | Strong conceptual match |
| Capability declaration | Fixed capability union in `ecosystem.ts`; separate boolean app-management capabilities in `crossPlatform.ts` | Partial; needs versioned, extensible manifests |
| AEO ecosystem membership | No signed AEO membership assertion or publisher trust proof in the inspected registration type | Missing in inspected contract |
| Publisher identity / key proof | Transport authentication is required by documentation, but not represented in the registration contract | Missing in inspected contract |
| Capability invocation contract | Current request contains peer, device, capability, request ID and protocol | Partial; lacks UCCS request envelope fields such as explicit scope, expiry, nonce and signed request proof |
| Authorization | Authenticated peer/device plus scoped, expiring, revocable grants | Useful foundation; needs a common cross-platform grant model |
| Consent | Explicit pairing/receive consent for LAN transfer | Present for transfer; not yet a universal capability-consent model |
| Replay protection | Documentation says replay must be rejected before network exposure | Requirement documented; not established by the inspected pure validator |
| Capability input/output schemas | Not represented in the inspected registration type | Missing in inspected contract |
| Discovery without central dependency | Generic recognition model; LAN companion documented | Partial; verify actual discovery transports and offline behavior |
| Registry/federation | No UCCS registry client found in inspected files | Not established |
| Cross-platform conformance tests | Existing pure contract helpers; UCCS-wide conformance suite not found in inspected files | Needs shared test vectors |

## 3. Required migration approach

1. Preserve the existing `aem-capabilities/1` and `aem-lan/1` behavior while a compatibility adapter is designed. Do not silently rename or break existing protocol identifiers.
2. Add UCCS membership as a separately verifiable assertion. A display name, package name, catalog listing, local discovery packet or AEO folder label must never prove membership.
3. Map existing AEM capabilities into a versioned UCCS capability manifest. Keep AEM's current internal capability types behind the adapter where possible.
4. Extend authenticated requests with the common UCCS request envelope: protocol version, request ID, issue/expiry times, requester/provider identities, capability/version, scopes, nonce and authenticated proof.
5. Keep peer authentication, authorization, user consent and AEO membership as separate checks.
6. Make registry discovery optional. Existing local/peer functionality must continue when a registry is unavailable.
7. Add shared positive and negative conformance vectors before enabling cross-platform network invocation.
8. Keep AEM's database, app identity, credentials and release lifecycle independent.

## 4. Security and compatibility gates

AEM must not be marked UCCS-conformant until all of the following are demonstrated:

- A valid AEO membership assertion is verified against an explicitly trusted publisher/issuer key.
- Invalid signatures, unknown issuers, expired assertions and revoked keys are rejected.
- A discovered or recognized platform receives no capability permission merely by being an AEO member.
- Requests are bound to the authenticated requester and intended provider.
- Expired, duplicated/replayed, out-of-scope and revoked requests are rejected.
- Consent is requested when the capability's policy requires it.
- Capability input is validated against the advertised schema before execution; output is validated before it is returned.
- No peer can read another app's private database or invoke an unadvertised capability.
- Registry outage does not disable direct authorized peer communication.
- Existing AEM transfer and app-management flows continue to pass their current tests.

## 5. Scope of this audit

This audit is based on the inspected AEM files:

- `docs/ecosystem-protocol.md`
- `src/domain/ecosystem.ts`
- `src/domain/crossPlatform.ts`
- `docs/TRANSFORMATION.md` (reviewed in the wider source audit)

This is not a complete audit of every transport, Android permission, backend route or test in AEM. Those must be inspected before implementation. No runtime files were changed by this audit.
