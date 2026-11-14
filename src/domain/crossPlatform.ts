/** Generic recognition. Display names are metadata; authentication and consent are separate. */
export type ConnectedPlatform = string; // publisher-owned reverse-DNS identifier

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

/** No fixed brand registry. Query the applications the user explicitly selected. */
export function emptyRecognition(platforms:ConnectedPlatform[]=[]):RecognitionResponse {
  return {recognized:[],notFound:[...new Set(platforms)]};
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
  const requested = [...new Set([...a.notFound,...b.notFound,...a.recognized.map(r=>r.platform),...b.recognized.map(r=>r.platform)])];
  const notFound = requested.filter(
    (p) => !recognized.some((r) => r.platform === p),
  );
  return { recognized, notFound };
}
