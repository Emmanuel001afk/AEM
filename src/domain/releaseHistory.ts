import type {Release} from "./model";

export interface ReleaseHistoryEntry {
  release: Release;
  reason: "published" | "withdrawn" | "rollback-target";
  createdAt: string;
}

function normalizedVersionName(value: unknown): string {
  return String(value || "").trim().replace(/^v(?=\d)/i, "").toLowerCase();
}

/**
 * Stable release identity for display/history. Android version codes are not
 * globally unique (and some publishers reuse them), so the version name and
 * channel are part of the key as well.
 */
export function releaseHistoryIdentity(release: any): string {
  const channel = String(release?.channel || "").toLowerCase();
  const releaseName = normalizedVersionName(release?.version?.name ?? release?.version_name);
  const artifactName = (release?.artifacts || []).find((artifact: any) => artifact?.platform === "android" && (artifact?.versionName || artifact?.artifact_version_name))?.versionName ?? (release?.artifacts || []).find((artifact: any) => artifact?.platform === "android" && artifact?.artifact_version_name)?.artifact_version_name;
  const name = releaseName && releaseName !== "unknown version" ? releaseName : normalizedVersionName(artifactName);
  const artifactCodes = (release?.artifacts || []).map((artifact: any) => Number(artifact?.versionCode ?? artifact?.version_code ?? 0)).filter((value: number) => Number.isFinite(value) && value > 0);
  const declaredCode = Number(release?.version?.code ?? release?.version_code ?? 0);
  const rawCode = Number.isFinite(declaredCode) && declaredCode > 0 ? declaredCode : Math.max(0, ...artifactCodes);
  const code = Number.isFinite(Number(rawCode)) && Number(rawCode) > 0 ? String(Number(rawCode)) : "";
  if (name && name !== "unknown version") return `${channel}|${name}|${code}`;
  // Do not merge anonymous releases merely because their numeric codes match.
  return `${channel}|release:${String(release?.id ?? release?.sourceReleaseId ?? "unknown")}`;
}

function artifactIdentity(artifact: any): string {
  return [
    String(artifact?.platform || "").toLowerCase(),
    String(artifact?.kind || "").toLowerCase(),
    String(artifact?.packageIdentity || artifact?.package_identity || "").toLowerCase(),
    String(artifact?.versionCode ?? artifact?.version_code ?? ""),
    normalizedVersionName(artifact?.versionName ?? artifact?.artifact_version_name),
    String(artifact?.sha256 || "").toLowerCase(),
    String(artifact?.downloadUrl || artifact?.download_url || ""),
  ].join("|");
}

function timestamp(value: unknown): number {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) && parsed <= Date.now() + 5 * 60 * 1000 ? parsed : 0;
}

/** Collapse source-level duplicate events while preserving distinct tags/builds. */
export function dedupeReleaseHistory(entries: ReleaseHistoryEntry[]): ReleaseHistoryEntry[] {
  const seenEvents = new Set<string>();
  const groups = new Map<string, ReleaseHistoryEntry[]>();
  for (const entry of Array.isArray(entries) ? entries : []) {
    // A rollback-target selection is an administrative event, not a new version.
    if (!entry?.release || entry.reason === "rollback-target") continue;
    const id = String(entry.release.id || entry.release.sourceReleaseId || "unknown");
    const eventKey = `${id}|${entry.reason}`;
    if (seenEvents.has(eventKey)) continue;
    seenEvents.add(eventKey);
    const key = releaseHistoryIdentity(entry.release);
    const group = groups.get(key) || [];
    group.push(entry);
    groups.set(key, group);
  }

  const merged: ReleaseHistoryEntry[] = [];
  for (const group of groups.values()) {
    // Prefer the source row with the most artifacts, but keep the earliest
    // authoritative publication date and merge artifacts from equivalent rows.
    const ordered = [...group].sort((a, b) =>
      (b.release.artifacts?.length || 0) - (a.release.artifacts?.length || 0) ||
      timestamp(a.release.publishedAt) - timestamp(b.release.publishedAt),
    );
    const primary = ordered[0];
    const artifacts = new Map<string, any>();
    for (const entry of group) {
      for (const artifact of entry.release.artifacts || []) {
        const key = artifactIdentity(artifact);
        if (!artifacts.has(key)) artifacts.set(key, artifact);
      }
    }
    const dates = group.map((entry) => entry.release.publishedAt).filter(Boolean) as string[];
    const publishedAt = dates.length ? dates.reduce((earliest, date) =>
      timestamp(date) < timestamp(earliest) ? date : earliest,
    ) : undefined;
    const withdrawn = group.some((entry) => entry.reason === "withdrawn" || entry.release.status === "withdrawn");
    const release = {
      ...primary.release,
      status: withdrawn ? "withdrawn" : primary.release.status,
      publishedAt,
      artifacts: [...artifacts.values()],
    };
    const reason = withdrawn ? "withdrawn" : "published";
    const createdAt = group.map((entry) => entry.createdAt).filter(Boolean).sort((a, b) => timestamp(a) - timestamp(b))[0] || "";
    merged.push({release, reason, createdAt});
  }
  return merged.sort((a, b) =>
    timestamp(b.release.publishedAt) - timestamp(a.release.publishedAt) ||
    timestamp(b.createdAt) - timestamp(a.createdAt) ||
    String(b.release.version?.name || "").localeCompare(String(a.release.version?.name || ""), undefined, {numeric: true}),
  );
}

function versionTuple(value: unknown): number[] | undefined {
  const match = /^v?(\d+(?:\.\d+){1,3})/i.exec(String(value || "").trim());
  if (!match) return undefined;
  return match[1].split(".").map((part) => Number(part));
}

function compareReleaseRecency(a: Release, b: Release): number {
  const aCode = Number(a.version?.code || 0);
  const bCode = Number(b.version?.code || 0);
  if (aCode !== bCode) return bCode - aCode;
  const aVersion = versionTuple(a.version?.name);
  const bVersion = versionTuple(b.version?.name);
  if (aVersion && bVersion) {
    for (let index = 0; index < Math.max(aVersion.length, bVersion.length); index++) {
      const difference = (bVersion[index] || 0) - (aVersion[index] || 0);
      if (difference) return difference;
    }
  }
  return timestamp(b.publishedAt) - timestamp(a.publishedAt);
}

function hasInstallableAndroid(release: Release): boolean {
  return release.status === "published" && (release.artifacts || []).some((artifact: any) =>
    artifact.platform === "android" && ["apk", "apks", "xapk", "apkm", "zip"].includes(String(artifact.kind || "").toLowerCase()) &&
    (String(artifact.kind || "").toLowerCase() !== "zip" || !!artifact.packageIdentity) &&
    !["pending", "processing", "failed"].includes(String(artifact.signingStatus || artifact.signing_status || "")),
  );
}

export function historyReleaseState(release: Release, entries: ReleaseHistoryEntry[], currentRelease?: Release): "current" | "previous" | "archived" {
  if (!hasInstallableAndroid(release)) return "archived";
  const current = currentRelease || entries.map((entry) => entry.release).filter(hasInstallableAndroid).sort(compareReleaseRecency)[0];
  if (!current) return "archived";
  const currentKey = releaseHistoryIdentity(current);
  const key = releaseHistoryIdentity(release);
  if (key === currentKey) return "current";

  const ordered = entries.map((entry) => entry.release)
    .filter(hasInstallableAndroid)
    .filter((candidate) => candidate.channel === current.channel)
    .filter((candidate, index, list) => list.findIndex((item) => releaseHistoryIdentity(item) === releaseHistoryIdentity(candidate)) === index)
    .sort(compareReleaseRecency);
  const currentIndex = ordered.findIndex((candidate) => releaseHistoryIdentity(candidate) === currentKey);
  const previous = currentIndex >= 0 ? ordered.slice(currentIndex + 1)[0] : ordered.find((candidate) => releaseHistoryIdentity(candidate) !== currentKey);
  return previous && releaseHistoryIdentity(previous) === key ? "previous" : "archived";
}
