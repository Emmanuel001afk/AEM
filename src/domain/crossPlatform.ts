/**
 * Cross-platform recognition (AEM side only).
 *
 * Recognizes sister AEM-family products on the user's device/network — AEM
 * Store itself, EMA (Email Marketing App), OEA (Office Editor App), Phormi,
 * and Central Hub — so AEM Store can show coherent "installed elsewhere"
 * status and hand off between them. Each product owns its own database and
 * identity; AEM Store never merges identities or databases, and makes no
 * changes to any other repository.
 */
export type ConnectedPlatform =
  | "aem-store"
  | "ema"
  | "oea"
  | "phormi"
  | "central-hub";

export interface PlatformIdentity {
  platform: ConnectedPlatform;
  appId: string; // e.g. package name or install key, scoped to that platform
  version?: string;
  installed: boolean;
}

export interface PlatformCapabilities {
  canInstall: boolean;
  canUpdate: boolean;
  canLaunch: boolean;
  canTransfer: boolean;
}

export interface ConnectedApp {
  platform: ConnectedPlatform;
  identity: PlatformIdentity;
  capabilities: PlatformCapabilities;
  source: "catalog" | "device-scan" | "user-declared";
  lastSeenAt?: string;
}

export interface RecognitionRequest {
  platforms: ConnectedPlatform[];
  includeCapabilities: boolean;
}

export interface RecognitionResponse {
  recognized: ConnectedApp[];
  notFound: ConnectedPlatform[];
  handshakeUrl?: string; // deep-link to launch a recognized partner app
}

/**
 * AEM-side registry of recognizable AEM-family platforms. Pure data — no network,
 * no DB writes, no merges. Each platform's DB boundary is preserved.
 */
export const RECOGNIZABLE_PLATFORMS: ConnectedPlatform[] = [
  "aem-store",
  "ema",
  "oea",
  "phormi",
  "central-hub",
];

export const PLATFORM_LABELS: Record<ConnectedPlatform, string> = {
  "aem-store": "AEM Store",
  ema: "EMA",
  oea: "OEA",
  phormi: "Phormi",
  "central-hub": "Central Hub",
};

/**
 * Empty recognition result: nothing recognized, nothing merged.
 */
export function emptyRecognition(): RecognitionResponse {
  return {
    recognized: [],
    notFound: [...RECOGNIZABLE_PLATFORMS],
  };
}

/**
 * Merge two recognition responses without merging identities or databases:
 * union of recognized apps, intersection-preserving not-found.
 */
export function mergeRecognition(
  a: RecognitionResponse,
  b: RecognitionResponse,
): RecognitionResponse {
  const seen = new Set<string>();
  const recognized: ConnectedApp[] = [];
  const push = (app: ConnectedApp) => {
    const key = `${app.platform}:${app.identity.appId}`;
    if (!seen.has(key)) {
      seen.add(key);
      recognized.push(app);
    }
  };
  a.recognized.forEach(push);
  b.recognized.forEach(push);
  const notFound = RECOGNIZABLE_PLATFORMS.filter(
    (p) => !recognized.some((r) => r.platform === p),
  );
  return { recognized, notFound };
}
