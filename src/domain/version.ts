import type {Artifact, InstalledApplication, Release} from "./model";

const ANDROID_INSTALLABLE_KINDS = new Set(["apk","apks","xapk","apkm"]);

function selectAndroidArtifact(release: Release, installed: InstalledApplication): Artifact | undefined {
  const android = release.artifacts.filter(
    (artifact) =>
      artifact.platform === "android" &&
      ANDROID_INSTALLABLE_KINDS.has(String(artifact.kind).toLowerCase()),
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
  return "installed";
}


/** Windows semantic versions are ordered independently of Android version codes. */
export function selectLatestWindowsRelease(releases: Release[]): Release | undefined {
  const tuple = (name: string) => /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(name)?.slice(1).map(Number);
  return releases.filter(r => r.status === "published" && r.channel === "stable" && tuple(r.version.name) && r.artifacts.some(a =>
    a.platform === "windows" && a.kind === "exe" && a.packageIdentity && /^[a-f0-9]{64}$/i.test(a.sha256 || "") && /^https:\/\//.test(a.downloadUrl)
  )).sort((a,b) => {
    const av = tuple(a.version.name)!, bv = tuple(b.version.name)!;
    for (let i=0;i<3;i++) if(av[i]!==bv[i]) return bv[i]-av[i];
    return 0;
  })[0];
}
