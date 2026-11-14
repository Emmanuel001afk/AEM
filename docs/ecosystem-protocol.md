# Application-neutral capabilities and recognition

`src/domain/ecosystem.ts` accepts **any** independently owned reverse-DNS application identity, bounded human display name, numeric version, device identity and supported capability set. There is no special permission for AEM, EMA, OEA, Phormi, Central Hub or any other brand. `crossPlatform.ts` recognizes the caller's explicitly requested IDs, not a hard-coded list. Existing catalog listings and historical adapters remain compatible; they do not define the ecosystem boundary.

Authorization is separate from recognition: a copied display name, a discovery advertisement or a catalog entry never grants access. Each application retains its own data, package ID and credentials. Capability requests require authenticated peer/device identity, explicit scoped grants, expiry/revocation and fresh request IDs. The pure contract validator cannot authenticate a transport or detect replay by itself.

The generic file-transfer transport is live separately as `aem-lan/1`: see [LAN companion](lan-transfer.md). It has real user pairing/receive consent, bearer grants, expiry and revocation. It deliberately does not expose unattended install, arbitrary file reads, screen control or another application's database.

Other capability adapters remain extension contracts; a platform can supply its own reviewed adapter without being added to a brand allowlist. Before exposing those capabilities over a network, authenticate stable peer keys, persist grants in secure local storage, reject replay, rate-limit, audit and require relevant local confirmation. The old Phormi-specific TypeScript shape is a deprecated compatibility interface, not an active privileged integration.
