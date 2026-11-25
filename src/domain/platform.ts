export type StoreHostPlatform = "android" | "windows" | "other";

export function hostFormatLabel(host: StoreHostPlatform): string {
  return host === "windows" ? "Windows EXE" : host === "android" ? "Android APK" : "Other platform";
}

export interface HostPlatformSignals {
  nativePlatform?: string;
  desktopPlatform?: string;
  userAgentDataPlatform?: string;
  navigatorPlatform?: string;
  userAgent?: string;
}

function formatIsoDate(value?: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : undefined;
}

function artifactDateLabel(artifact: any, release: any, assetLabel: string): string | undefined {
  const updated = formatIsoDate(artifact?.sourceUpdatedAt ?? artifact?.source_updated_at);
  if (updated) return `${assetLabel} updated ${updated}`;
  const published = formatIsoDate(release?.publishedAt ?? release?.published_at);
  return published ? `Release published ${published}` : undefined;
}

function classifyPlatform(value?: string): StoreHostPlatform | undefined {
  const platform = String(value || "").trim().toLowerCase();
  if (!platform) return undefined;
  if (/^(win|win32|win64|windows)(\b|$)/.test(platform) || platform.includes("windows")) return "windows";
  if (platform.includes("android")) return "android";
  if (/^(darwin|mac|macintel|linux|ios|iphone|ipad)(\b|$)/.test(platform)) return "other";
  return undefined;
}

/** Resolve the OS format to prefer without granting desktop-bridge capabilities. */
export function detectHostPlatform(signals: HostPlatformSignals): StoreHostPlatform {
  if (signals.desktopPlatform) return classifyPlatform(signals.desktopPlatform) || "other";
  if (signals.nativePlatform && signals.nativePlatform.toLowerCase() !== "web") {
    return classifyPlatform(signals.nativePlatform) || "other";
  }
  let fallback: StoreHostPlatform | undefined;
  for (const signal of [signals.userAgentDataPlatform, signals.navigatorPlatform, signals.userAgent]) {
    const platform = classifyPlatform(signal);
    if (platform === "windows" || platform === "android") return platform;
    if (platform) fallback = platform;
  }
  return fallback || "other";
}

const ANDROID_INSTALLABLE_KINDS = new Set(["apk", "apks", "xapk", "apkm", "zip"]);
const WINDOWS_INSTALLABLE_KINDS = new Set(["exe"]);
const WINDOWS_IDENTITY_RE = /^[A-Za-z][A-Za-z0-9_.-]{2,199}$/;
const WINDOWS_GUID_RE = /^\{[a-f\d]{8}(-[a-f\d]{4}){3}-[a-f\d]{12}\}$/i;

export function normalizeWindowsPackageIdentity(rawIdentity?: string | null, fallbackIdentity?: string | null): string {
  const raw = String(rawIdentity || "").trim();
  if (WINDOWS_IDENTITY_RE.test(raw) || WINDOWS_GUID_RE.test(raw)) return raw;
  const fallback = String(fallbackIdentity || "").trim();
  if (WINDOWS_IDENTITY_RE.test(fallback) || WINDOWS_GUID_RE.test(fallback)) return fallback;
  const sanitized = raw
    .replace(/^github:/i, "github.")
    .replace(/[^A-Za-z0-9_.-]+/g, ".")
    .replace(/\.+/g, ".")
    .replace(/^\.+|\.+$/g, "");
  return WINDOWS_IDENTITY_RE.test(sanitized) ? sanitized.slice(0, 200) : "aem.windows.app";
}

export function extractNumericWindowsVersion(raw?: string | null): string {
  const text = String(raw || "").trim();
  if (!text) return "";
  const exact = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$/i.exec(text);
  if (exact) {
    const [, a, b, c, d] = exact;
    return !d || d === "0" ? `${a}.${b}.${c}` : `${a}.${b}.${c}.${d}`;
  }
  const embedded = /(?:^|[^0-9.])v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?(?:[-_. ]|$)/i.exec(text);
  if (embedded) {
    const [, a, b, c, d] = embedded;
    return !d || d === "0" ? `${a}.${b}.${c}` : `${a}.${b}.${c}.${d}`;
  }
  return "";
}

export function resolveWindowsVersion(release?: any, artifact?: any): string {
  return (
    extractNumericWindowsVersion(artifact?.versionName ?? artifact?.artifact_version_name) ||
    extractNumericWindowsVersion(release?.version?.name ?? release?.version_name) ||
    extractNumericWindowsVersion(artifact?.filename) ||
    String(artifact?.versionName ?? artifact?.artifact_version_name ?? release?.version?.name ?? release?.version_name ?? "").replace(/^v/i, "")
  );
}

function isX86_64Filename(filename?: string): boolean {
  return /(^|[-_.])(x86_64|amd64)([-. _]|$)/i.test(String(filename || ""));
}

export function androidArtifact(release: any, packageIdentity?: string, options?: { preferArch?: "x86_64" | "mobile" }) {
  const list = (release?.artifacts || []).filter((artifact: any) =>
    artifact.platform === "android" &&
    ANDROID_INSTALLABLE_KINDS.has(String(artifact.kind || "").toLowerCase()) &&
    (String(artifact.kind || "").toLowerCase() !== "zip" || !!artifact.packageIdentity) &&
    (artifact.signingStatus ?? artifact.signing_status) === "ready",
  );
  const matching = packageIdentity ? list.filter((artifact: any) => artifact.packageIdentity === packageIdentity) : [];
  const candidates = matching.length ? matching : list;
  const known = candidates.filter((artifact: any) => Number(artifact.versionCode ?? 0) > 0);
  return (known.length ? known : candidates).sort((a: any, b: any) => {
    const code = Number(b.versionCode ?? 0) - Number(a.versionCode ?? 0);
    if (code) return code;
    if (options?.preferArch === "x86_64") {
      const diff = (isX86_64Filename(b.filename) ? 1 : 0) - (isX86_64Filename(a.filename) ? 1 : 0);
      if (diff) return diff;
    } else if (options?.preferArch === "mobile") {
      const diff = (isX86_64Filename(a.filename) ? 1 : 0) - (isX86_64Filename(b.filename) ? 1 : 0);
      if (diff) return diff;
    }
    const aRelease = /(^|[-_. ])debug([-. _]|$)/i.test(String(a.filename || "")) ? 0 : 1;
    const bRelease = /(^|[-_. ])debug([-. _]|$)/i.test(String(b.filename || "")) ? 0 : 1;
    if (bRelease !== aRelease) return bRelease - aRelease;
    const bTime = Date.parse(String(b.sourceUpdatedAt ?? b.source_updated_at ?? "")) || 0;
    const aTime = Date.parse(String(a.sourceUpdatedAt ?? a.source_updated_at ?? "")) || 0;
    return bTime - aTime;
  })[0];
}

function windowsArtifactPriority(filename?: string): number {
  const lower = String(filename || "").toLowerCase();
  if (/worker|helper|service/.test(lower)) return 0;
  if (/portable/.test(lower)) return 1;
  if (/setup|installer/.test(lower)) return 3;
  return 2;
}

export function windowsArtifacts(release: any) {
  return (release?.artifacts || []).filter((artifact: any) =>
    artifact.platform === "windows" &&
    WINDOWS_INSTALLABLE_KINDS.has(String(artifact.kind || "").toLowerCase()) &&
    !!artifact.packageIdentity &&
    /^[a-f0-9]{64}$/i.test(String(artifact.sha256 || "")) &&
    /^https:\/\//i.test(String(artifact.downloadUrl || "")),
  ).sort((a: any, b: any) => windowsArtifactPriority(b.filename) - windowsArtifactPriority(a.filename));
}

export function platformSummary(app: any, host: StoreHostPlatform): string {
  const available: string[] = [];
  if (androidArtifact(app?.latest, app?.packageIdentity)) available.push("android");
  if (windowsArtifacts(app?.windowsLatest).length) available.push("windows");
  const preferred = host === "windows" ? "windows" : "android";
  available.sort((a, b) => a === preferred ? -1 : b === preferred ? 1 : a.localeCompare(b));
  const labels: Record<string, string> = { android: "Android APK", windows: "Windows EXE" };
  return available.map(platform => labels[platform]).join(" · ") || "No verified installer";
}

export function primaryReleaseInfo(app: any, host: StoreHostPlatform) {
  const preferArch = host === "android" ? "mobile" as const : undefined;
  const android = androidArtifact(app?.latest, app?.packageIdentity, preferArch ? { preferArch } : undefined);
  const windows = windowsArtifacts(app?.windowsLatest)[0];
  const androidVersion = String(android?.versionName || app?.latest?.version?.name || "Unknown version");
  const windowsVersion = resolveWindowsVersion(app?.windowsLatest, windows) || String(app?.windowsLatest?.version?.name || "Unknown version");

  if (host === "windows" && windows) {
    return {
      platform: "windows" as const,
      label: "Windows EXE",
      version: windowsVersion,
      detail: `Package · ${normalizeWindowsPackageIdentity(windows.packageIdentity, app?.packageIdentity)}`,
      dateLabel: artifactDateLabel(windows, app.windowsLatest, "Windows installer"),
      release: app.windowsLatest,
      artifact: windows,
    };
  }
  if (host !== "windows" && android) {
    const code = android.versionCode ?? app?.latest?.version?.code;
    return {
      platform: "android" as const,
      label: "Android APK",
      version: androidVersion,
      detail: `Version code · ${code ?? "unknown"}`,
      dateLabel: artifactDateLabel(android, app.latest, "APK"),
      release: app.latest,
      artifact: android,
    };
  }
  if (android) {
    const code = android.versionCode ?? app?.latest?.version?.code;
    return {
      platform: "android" as const,
      label: "Android APK · no Windows EXE available",
      version: androidVersion,
      detail: `Version code · ${code ?? "unknown"} · APK requires Android or an emulator`,
      dateLabel: artifactDateLabel(android, app.latest, "APK"),
      release: app.latest,
      artifact: android,
    };
  }
  if (windows) {
    return {
      platform: "windows" as const,
      label: host === "android" ? "Windows EXE · for Windows only" : "Windows EXE",
      version: windowsVersion,
      detail: `Package · ${normalizeWindowsPackageIdentity(windows.packageIdentity, app?.packageIdentity)}`,
      dateLabel: artifactDateLabel(windows, app.windowsLatest, "Windows installer"),
      release: app.windowsLatest,
      artifact: windows,
    };
  }
  return undefined;
}

export function appCardVersion(
  app: any,
  host: StoreHostPlatform,
  installed?: { versionName: string; versionCode: number },
  windowsStatus?: { installed: Array<{ version: string }>; state: string },
): string {
  const info = primaryReleaseInfo(app, host);
  if (!info) return installed ? `Installed ${installed.versionName}` : "No installable release published";
  const winInstalledVer = windowsStatus?.installed?.[0]?.version;
  const installedLabel = info.platform === "android" && installed
    ? ` · Installed ${installed.versionName}`
    : info.platform === "windows" && winInstalledVer
    ? ` · Installed ${winInstalledVer}${windowsStatus?.state === "update" ? " · Update available" : ""}`
    : "";
  const dateLabel = info.dateLabel ? ` · ${info.dateLabel}` : "";
  return `${info.label} · Version ${info.version}${dateLabel}${installedLabel}`;
}

export function androidActionLabel(action: string): string {
  return action === "INSTALL" ? "INSTALL APK" : action === "UPDATE" ? "UPDATE APK" : action;
}
