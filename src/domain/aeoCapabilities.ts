import {
  CAPABILITIES,
  ECOSYSTEM_PROTOCOL,
  type Capability,
  validPlatformId,
} from "./ecosystem";

export const AEO_CAPABILITY_MANIFEST_PROTOCOL = "uccs/1" as const;
export const AEO_CAPABILITY_MANIFEST_TYPE = "aeo.capability-manifest/1" as const;

const TITLES: Record<Capability, string> = {
  "application.metadata.read": "Read application metadata",
  "delivery.request": "Request application delivery",
  "transfer.offer": "Offer an application or file transfer",
  "phone.session.request": "Request a phone session",
};

export interface AeoCapabilityManifestEntry {
  id: string;
  title: string;
  sourceProtocol: typeof ECOSYSTEM_PROTOCOL;
  sourceCapabilityId: Capability;
}

export interface AeoCapabilityManifest {
  protocol: typeof AEO_CAPABILITY_MANIFEST_PROTOCOL;
  type: typeof AEO_CAPABILITY_MANIFEST_TYPE;
  ecosystem: "AEO";
  platform: { id: string; name: string; version: string };
  generatedAt: number;
  expiresAt: number;
  capabilities: readonly AeoCapabilityManifestEntry[];
}

export interface AemManifestIdentity {
  platformId: string;
  displayName: string;
  version: string;
}

/**
 * Publishes only AEM's existing capability catalogue through the UCCS envelope.
 * It does not expose a device endpoint, grant permission, or replace aem-capabilities/1.
 */
export function createAemAeoCapabilityManifest(
  identity: AemManifestIdentity,
  now = Date.now(),
  lifetimeMs = 5 * 60_000,
): AeoCapabilityManifest {
  if (!validPlatformId(identity.platformId) ||
      typeof identity.displayName !== "string" ||
      !identity.displayName.trim() ||
      identity.displayName.length > 100 ||
      !/^\d+\.\d+\.\d+$/.test(identity.version) ||
      !Number.isSafeInteger(now) ||
      !Number.isSafeInteger(lifetimeMs) ||
      lifetimeMs < 1_000 || lifetimeMs > 10 * 60_000) {
    throw new TypeError("Invalid AEM capability-manifest identity or lifetime");
  }
  const capabilities = CAPABILITIES.map((capability) => Object.freeze({
    id: capability,
    title: TITLES[capability],
    sourceProtocol: ECOSYSTEM_PROTOCOL,
    sourceCapabilityId: capability,
  }));
  return Object.freeze({
    protocol: AEO_CAPABILITY_MANIFEST_PROTOCOL,
    type: AEO_CAPABILITY_MANIFEST_TYPE,
    ecosystem: "AEO",
    platform: Object.freeze({
      id: identity.platformId,
      name: identity.displayName,
      version: identity.version,
    }),
    generatedAt: now,
    expiresAt: now + lifetimeMs,
    capabilities: Object.freeze(capabilities),
  });
}

/**
 * Structural validation only. A valid manifest is discovery metadata, not
 * peer authentication, capability authorization, or proof of user consent.
 */
export function validateAeoCapabilityManifest(
  value: unknown,
  now = Date.now(),
): value is AeoCapabilityManifest {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Number.isSafeInteger(now)) {
    return false;
  }
  const manifest = value as AeoCapabilityManifest;
  if (manifest.protocol !== AEO_CAPABILITY_MANIFEST_PROTOCOL ||
      manifest.type !== AEO_CAPABILITY_MANIFEST_TYPE ||
      manifest.ecosystem !== "AEO" ||
      !manifest.platform || !validPlatformId(manifest.platform.id) ||
      typeof manifest.platform.name !== "string" ||
      !manifest.platform.name.trim() || manifest.platform.name.length > 100 ||
      typeof manifest.platform.version !== "string" ||
      !/^\d+\.\d+\.\d+$/.test(manifest.platform.version) ||
      !Number.isSafeInteger(manifest.generatedAt) ||
      !Number.isSafeInteger(manifest.expiresAt) ||
      manifest.generatedAt > now + 60_000 ||
      manifest.expiresAt <= now ||
      manifest.expiresAt <= manifest.generatedAt ||
      manifest.expiresAt - manifest.generatedAt > 10 * 60_000 ||
      !Array.isArray(manifest.capabilities) ||
      manifest.capabilities.length > CAPABILITIES.length) {
    return false;
  }
  const seen = new Set<string>();
  return manifest.capabilities.every((entry) =>
    !!entry &&
    typeof entry.id === "string" &&
    !seen.has(entry.id) &&
    !!seen.add(entry.id) &&
    entry.sourceProtocol === ECOSYSTEM_PROTOCOL &&
    CAPABILITIES.includes(entry.sourceCapabilityId) &&
    entry.id === entry.sourceCapabilityId &&
    entry.title === TITLES[entry.sourceCapabilityId],
  );
}
