import type {Artifact, InstalledApplication, Release} from "./model";
import {parseCatalogTimestamp} from "./time";

const ANDROID_INSTALLABLE_KINDS = new Set(["apk","apks","xapk","apkm"]);

/** Compare parseable dotted versions, returning newest-first order. */
export function compareVersionNamesNewestFirst(a?: string, b?: string): number {
  const parse = (value?: string) => {
    const match = /^v?(\d+(?:\.\d+){1,3})(?:[-+].*)?$/i.exec(String(value || "").trim());
    return match ? match[1].split(".").map(Number) : undefined;
  };
  const left = parse(a), right = parse(b);
  if (!left || !right) return 0;
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (right[index] || 0) - (left[index] || 0);
    if (difference) return difference;
  }
  return 0;
}

function selectAndroidArtifact(release: Release, installed: InstalledApplication): Artifact | undefined {
  const android = release.artifacts.filter(
    (artifact) =>
      artifact.platform === "android" &&
      ANDROID_INSTALLABLE_KINDS.has(String(artifact.kind).toLowerCase()) &&
      !["pending", "processing", "failed"].includes(String((artifact as any).signingStatus ?? (artifact as any).signing_status ?? "")),
  );

  if (!android.length) return undefined;

  const identityMatches = android.filter(
    (artifact) => artifact.packageIdentity === installed.packageIdentity,
  );
  const candidates = identityMatches.length ? identityMatches : android;

  return [...candidates].sort((a, b) => {
    const codeA = a.versionCode ?? release.version.code ?? 0;
    const codeB = b.versionCode ?? release.version.code ?? 0;
    return codeB - codeA;
  })[0];
}

export function compareAndroidRelease(
  release: Release,
  installed: InstalledApplication,
): "update-available" | "installed" | "local-newer" | "identity-mismatch" {
  const artifact = selectAndroidArtifact(release, installed);

  if (!artifact || !artifact.packageIdentity || artifact.packageIdentity !== installed.packageIdentity) {
    return "identity-mismatch";
  }

  const availableCert = String(artifact.signingCertificateSha256 ?? "")
    .replace(/:/g, "")
    .toLowerCase();
  const installedCert = String(installed.signingCertificateSha256 ?? "")
    .replace(/:/g, "")
    .toLowerCase();

  if (availableCert && installedCert && availableCert !== installedCert) {
    return "identity-mismatch";
  }

  const releaseCode = artifact.versionCode ?? release.version.code ?? 0;

  if (releaseCode > installed.versionCode) return "update-available";
  if (releaseCode < installed.versionCode) return "local-newer";
  const namedVersionOrder = compareVersionNamesNewestFirst(artifact.versionName ?? release.version.name, installed.versionName);
  if (namedVersionOrder < 0) return "update-available";
  if (namedVersionOrder > 0) return "local-newer";
  return "installed";
}


/** Windows semantic versions are ordered independently of Android version codes. */
export function selectLatestWindowsRelease(releases: Release[]): Release | undefined {
  const verifiedExe = (a: Artifact) =>
    a.platform === "windows" && a.kind === "exe" && !!a.packageIdentity && /^[a-f0-9]{64}$/i.test(a.sha256 || "") && /^https:\/\//.test(a.downloadUrl);
  const parseTuple = (value?: string): number[] | undefined => {
    const clean = String(value || "").trim().replace(/^v/i, "");
    const m = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$/.exec(clean);
    if (m) return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] || 0)];
    return undefined;
  };
  const extractFilenameTuple = (name?: string): number[] | undefined => {
    const m = /(?:^|[^0-9.])v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?(?:[-_. ]|$)/i.exec(String(name || ""));
    return m ? [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] || 0)] : undefined;
  };
  const releaseTuple = (r: Release): number[] | undefined => {
    const direct = parseTuple(r.version?.name);
    if (direct) return direct;
    for (const a of r.artifacts || []) {
      if (!verifiedExe(a)) continue;
      const fromArt = parseTuple(a.versionName);
      if (fromArt) return fromArt;
      const fromFile = extractFilenameTuple(a.filename);
      if (fromFile) return fromFile;
    }
    return undefined;
  };
  const releaseTs = (r: Release): number => {
    const times = [
      parseCatalogTimestamp(r.publishedAt),
      ...(r.artifacts || []).filter(verifiedExe).map((a) => parseCatalogTimestamp(a.sourceUpdatedAt)),
    ];
    return Math.max(0, ...times);
  };
  const all = releases.filter((r) => r.status === "published" && r.artifacts.some(verifiedExe));
  const published = all.filter((r) => String(r.sourceReleaseId || "").startsWith("github-release-"));
  // Prefer a GitHub release; workflow or repository binaries remain a fallback.
  const eligible = published.length ? published : all;
  const semver = eligible.filter((r) => !!releaseTuple(r)).sort((a, b) => {
    const av = releaseTuple(a)!, bv = releaseTuple(b)!;
    for (let i = 0; i < 4; i++) if ((av[i] || 0) !== (bv[i] || 0)) return (bv[i] || 0) - (av[i] || 0);
    return releaseTs(b) - releaseTs(a);
  });
  if (semver.length) return semver[0];
  return eligible.sort((a, b) => releaseTs(b) - releaseTs(a))[0];
}
