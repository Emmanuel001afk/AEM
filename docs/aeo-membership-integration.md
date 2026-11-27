# AEM integration: AEO membership and UCCS

AEM Store keeps its existing `aem-capabilities/1` registration and capability-grant behavior. The new AEO envelope is separate and additive.

- AEO Framework identity: `AEO`
- UCCS protocol version: `uccs/1`
- AEM Store platform ID: `com.aem.store` (matches the existing desktop app ID)
- Membership proof: signed compact JWS, EdDSA/Ed25519, verified against caller-supplied AEO trust keys.
- The AEO envelope binds the signed membership's platform ID and display name to the registration.

The adapter verifies ecosystem membership only. It does not prove that an installed binary is genuine, authenticate a device, or grant capabilities. Existing `aem-capabilities/1` peer authentication and scoped grants remain separate. Do not treat an AEO membership proof as a capability grant.

No production trust key or credential is included. The adapter now verifies a root-signed trust bundle against pinned root public keys, validates issuer-key records and the revocation list, and rejects expired or rolled-back bundle versions. The caller must persist the highest accepted bundle version and supply it as `minimumVersion`; this function does not persist state. Unknown or unavailable revocation status fails closed. Root-key rotation/recovery and live issuer/revocation distribution remain production prerequisites.

Tests generate an ephemeral Ed25519 test key and cover signature, issuer, audience, expiry, revocation, protocol and registration-identity failures. No live credentials are generated.


## UCCS capability manifest adapter

`src/domain/aeoCapabilities.ts` exposes AEM's existing `aem-capabilities/1` catalogue as a short-lived `uccs/1` discovery manifest. It does not invent a second AEM capability catalogue, publish device endpoints, grant peer access, or replace AEM's existing authenticated peer/device and scoped-grant checks. A manifest is discovery metadata only; the provider must still authenticate the peer, check the active grant, apply scope/expiry/replay protections, and obtain user consent where the operation requires it.
