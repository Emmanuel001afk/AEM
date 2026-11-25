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
  // Catalog timing means the upstream release's publication date. An asset can be
  // replaced/re-uploaded well after a release, so its update timestamp must not
  // silently become the release date shown to users.
  const published = formatIsoDate(release?.publishedAt ?? release?.published_at);
  if (published) return `Release published ${published}`;
  const updated = formatIsoDate(artifact?.sourceUpdatedAt ?? artifact?.source_updated_at);
  return updated ? `${assetLabel} asset updated ${updated}` : undefined;
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

export function androidArtifact(release: any, packageIdentity?: string) {
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
    const aRelease = /(^|[-_. ])debug([-. _]|$)/i.test(String(a.filename || "")) ? 0 : 1;
    const bRelease = /(^|[-_. ])debug([-. _]|$)/i.test(String(b.filename || "")) ? 0 : 1;
    return bRelease - aRelease;
  })[0];
}

export function windowsArtifacts(release: any) {
  return (release?.artifacts || []).filter((artifact: any) =>
    artifact.platform === "windows" &&
    WINDOWS_INSTALLABLE_KINDS.has(String(artifact.kind || "").toLowerCase()) &&
    !!artifact.packageIdentity &&
    /^[a-f0-9]{64}$/i.test(String(artifact.sha256 || "")) &&
    /^https:\/\//i.test(String(artifact.downloadUrl || "")),
  );
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
  const android = androidArtifact(app?.latest, app?.packageIdentity);
  const windows = windowsArtifacts(app?.windowsLatest)[0];
  const androidVersion = String(android?.versionName || app?.latest?.version?.name || "Unknown version");
  const windowsVersion = String(app?.windowsLatest?.version?.name || "Unknown version");

  if (host === "windows" && windows) {
    return {
      platform: "windows" as const,
      label: "Windows EXE",
      version: windowsVersion,
      detail: `Package · ${windows.packageIdentity}`,
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
      detail: `Package · ${windows.packageIdentity}`,
      dateLabel: artifactDateLabel(windows, app.windowsLatest, "Windows installer"),
      release: app.windowsLatest,
      artifact: windows,
    };
  }
  return undefined;
}

export function appCardVersion(app: any, host: StoreHostPlatform, installed?: { versionName: string; versionCode: number }): string {
  const info = primaryReleaseInfo(app, host);
  if (!info) return installed ? `Installed ${installed.versionName}` : "No installable release published";
  const installedLabel = info.platform === "android" && installed ? ` · Installed ${installed.versionName}` : "";
  const dateLabel = info.dateLabel ? ` · ${info.dateLabel}` : "";
  return `${info.label} · Version ${info.version}${dateLabel}${installedLabel}`;
}

export function androidActionLabel(action: string): string {
  return action === "INSTALL" ? "INSTALL APK" : action === "UPDATE" ? "UPDATE APK" : action;
}
