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
