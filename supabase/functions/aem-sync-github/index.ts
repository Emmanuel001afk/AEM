import { createClient } from "npm:@supabase/supabase-js@2";

const GH = "https://api.github.com";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization,apikey,content-type,x-aem-sync-secret",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: cors });
const client = () => {
  const key = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}").default || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!key) throw new Error("Supabase server key unavailable");
  return createClient(Deno.env.get("SUPABASE_URL")!, key);
};
const artifactKind = (name: string): string | null => {
  const n = name.toLowerCase();
  return ["apk", "apks", "xapk", "apkm", "exe"].find((ext) => n.endsWith(`.${ext}`)) || null;
};
const platform = (kind: string) => kind === "exe" ? "windows" : "android";
const releaseChannel = (text: string): "stable" | "beta" | "development" => {
  if (/(^|[-_.])(beta|b)([-_.]|\d|$)/i.test(text)) return "beta";
  if (/(^|[-_.])(dev|development|debug|nightly|alpha|canary)([-_.]|\d|$)/i.test(text)) return "development";
  return "stable";
};
const safeName = (name: string) => name.replace(/[^A-Za-z0-9._-]/g, "_");
const WINDOWS_ID_RE = /^[A-Za-z][A-Za-z0-9_.-]{2,199}$/;
const sanitizeWindowsIdentity = (appPackageIdentity: string | null | undefined, repoFullName: string): string => {
  const pkg = String(appPackageIdentity || "").trim();
  if (WINDOWS_ID_RE.test(pkg)) return pkg;
  const normalized = `github.${repoFullName.replace(/[^A-Za-z0-9_.-]+/g, ".").replace(/\.+/g, ".").replace(/^\.+|\.+$/g, "")}`;
  return WINDOWS_ID_RE.test(normalized) ? normalized.slice(0, 200) : "aem.windows.app";
};
const extractVersionTuple = (text: string): string | null => {
  const cleaned = String(text || "").trim();
  if (!cleaned) return null;
  const match = /(?:^|[^0-9.])v?(\d+\.\d+\.\d+(?:\.\d+)?)(?:[-+._A-Za-z0-9]*)?(?:$|[^0-9.])/i.exec(cleaned);
  if (!match) return null;
  const parts = match[1].split(".").map(Number);
  if (parts.length < 3 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 65535)) return null;
  return parts.length === 4 && parts[3] === 0 ? `${parts[0]}.${parts[1]}.${parts[2]}` : parts.join(".");
};
const extractPeVersion = (bytes?: Uint8Array): string | null => {
  if (!bytes || bytes.length < 64) return null;
  // Scan for VS_FIXEDFILEINFO signature 0xFEEF04BD (little-endian BD 04 EF FE)
  for (let i = 0; i + 52 <= bytes.length; i++) {
    if (bytes[i] !== 0xbd || bytes[i + 1] !== 0x04 || bytes[i + 2] !== 0xef || bytes[i + 3] !== 0xfe) continue;
    const view = new DataView(bytes.buffer, bytes.byteOffset + i, 52);
    const ms = view.getUint32(8, true);
    const ls = view.getUint32(12, true);
    const major = (ms >>> 16) & 0xffff;
    const minor = ms & 0xffff;
    const build = (ls >>> 16) & 0xffff;
    const rev = ls & 0xffff;
    if (major === 0 && minor === 0 && build === 0 && rev === 0) continue;
    return rev === 0 ? `${major}.${minor}.${build}` : `${major}.${minor}.${build}.${rev}`;
  }
  return null;
};
const extractExeVersion = (bytes: Uint8Array | undefined, filename: string, releaseName: string): string | null => {
  return extractVersionTuple(filename) || extractVersionTuple(releaseName) || extractPeVersion(bytes);
};
const apkVariantKey = (filename: string, packageIdentity: string): string => {
  const pkg = String(packageIdentity || "").toLowerCase() || "unknown";
  const lower = String(filename || "").toLowerCase();
  if (/(^|[-_.])(x86_64|amd64)([-. _]|$)/.test(lower)) return `${pkg}:x86_64`;
  if (/(^|[-_.])(x86)([-. _]|$)/.test(lower)) return `${pkg}:x86`;
  if (/(^|[-_.])(arm64|aarch64|arm64-v8a)([-. _]|$)/.test(lower)) return `${pkg}:arm64`;
  if (/(^|[-_.])(armeabi|armv7)([-. _]|$)/.test(lower)) return `${pkg}:armv7`;
  return `${pkg}:default`;
};
const releaseActivity = (release: any) => Math.max(
  Date.parse(release.published_at || release.created_at || "") || 0,
  ...(release.assets || []).map((asset: any) => Date.parse(asset.updated_at || "") || 0),
);
const MAX_WORKFLOW_ARTIFACTS_PER_REPO = 20;
const MAX_WORKFLOW_ARCHIVE_BYTES_PER_REPO = 70 * 1024 * 1024;
const MAX_DISCOVERED_BINARY_BYTES_PER_REPO = 50 * 1024 * 1024;
const MAX_PUBLIC_RELEASE_APK_BYTES = 200 * 1024 * 1024;
const MAX_SYNC_REPOSITORIES_PER_INVOCATION = 1;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;

async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [da, dbHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const ua = new Uint8Array(da);
  const ub = new Uint8Array(dbHash);
  let diff = 0;
  for (let i = 0; i < ua.length; i++) diff |= ua[i] ^ ub[i];
  return diff === 0;
}

const gh = async (url: string, headers: HeadersInit) => {
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`GitHub API HTTP ${response.status}`);
  return response.json();
};

function previousFailures(value: unknown): { count: number; details: string[] } {
  if (!value) return { count: 0, details: [] };
  try {
    const parsed = JSON.parse(String(value));
    if (Array.isArray(parsed)) return { count: parsed.length, details: parsed.map(String) };
    if (parsed && Array.isArray(parsed.details)) return { count: Number(parsed.count) || parsed.details.length, details: parsed.details.map(String) };
  } catch {
    // Preserve a pre-upgrade plain-text error as a single scan failure.
  }
  return { count: 1, details: [String(value)] };
}

async function inflateBounded(raw: Uint8Array, maxBytes: number): Promise<Uint8Array | null> {
  const stream = new Blob([raw.slice().buffer as ArrayBuffer]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || !value.byteLength) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

async function unzipEntry(buf: Uint8Array, wanted: string) {
  if (buf.length < 22) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const u16 = (p: number) => dv.getUint16(p, true), u32 = (p: number) => dv.getUint32(p, true);
  const e = Math.max(0, buf.length - 65558);
  for (let p = buf.length - 22; p >= e; p--) {
    if (u32(p) !== 0x06054b50) continue;
    const n = u16(p + 10), off = u32(p + 16);
    if (off >= buf.length) return null;
    let q = off;
    for (let i = 0; i < n && q + 46 <= buf.length; i++) {
      if (u32(q) !== 0x02014b50) break;
      const method = u16(q + 10), cs = u32(q + 20), us = u32(q + 24), nl = u16(q + 28), xl = u16(q + 30), cl = u16(q + 32), lo = u32(q + 42);
      if (q + 46 + nl + xl + cl > buf.length) break;
      const name = new TextDecoder().decode(buf.slice(q + 46, q + 46 + nl));
      q += 46 + nl + xl + cl;
      if (name !== wanted) continue;
      if (us > MAX_MANIFEST_BYTES || cs > MAX_MANIFEST_BYTES) return null;
      if (lo + 30 > buf.length) return null;
      const ln = u16(lo + 26), lx = u16(lo + 28);
      const dataStart = lo + 30 + ln + lx;
      if (dataStart + cs > buf.length) return null;
      const raw = buf.slice(dataStart, dataStart + cs);
      if (method === 0) return raw.byteLength <= MAX_MANIFEST_BYTES ? raw : null;
      if (method === 8) return await inflateBounded(raw, MAX_MANIFEST_BYTES);
      return null;
    }
  }
  return null;
}

async function apkMetadata(buf: Uint8Array) {
  const manifest = await unzipEntry(buf, "AndroidManifest.xml");
  return manifest ? parseApkManifest(manifest) : {};
}

function apkHasSignature(buf: Uint8Array) {
  try {
    if (buf.length < 22) return false;
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const u16 = (p: number) => view.getUint16(p, true), u32 = (p: number) => view.getUint32(p, true);
    const end = Math.max(0, buf.length - 65558);
    for (let p = buf.length - 22; p >= end; p--) {
      if (u32(p) !== 0x06054b50) continue;
      const count = u16(p + 10), central = u32(p + 16);
      if (central >= 16 && central <= buf.length) {
        const magic = new TextDecoder().decode(buf.slice(central - 16, central));
        if (magic === "APK Sig Block 42") return true;
      }
      let cursor = central;
      for (let i = 0; i < count && cursor + 46 <= buf.length; i++) {
        if (u32(cursor) !== 0x02014b50) break;
        const nameLength = u16(cursor + 28), extraLength = u16(cursor + 30), commentLength = u16(cursor + 32);
        if (cursor + 46 + nameLength + extraLength + commentLength > buf.length) break;
        const name = new TextDecoder().decode(buf.slice(cursor + 46, cursor + 46 + nameLength)).toUpperCase();
        if (/^META-INF\/[^/]+\.(RSA|DSA|EC)$/.test(name)) return true;
        cursor += 46 + nameLength + extraLength + commentLength;
      }
      return false;
    }
  } catch {}
  return false;
}

function readU16(v: DataView, p: number) { return v.getUint16(p, true); }
function readU32(v: DataView, p: number) { return v.getUint32(p, true); }
function readLen8(b: Uint8Array, p: number) { let n = 0, shift = 0, x = 0; do { x = b[p++]; n |= (x & 127) << shift; shift += 7; } while (x & 128); return [n, p] as const; }
function readLen16(v: DataView, p: number) { const first = readU16(v, p); if (first & 0x8000) return [((first & 0x7fff) << 16) | readU16(v, p + 2), p + 4] as const; return [first, p + 2] as const; }
function axmlStrings(buf: Uint8Array, v: DataView, off: number) {
  if (readU16(v, off) !== 1) return null;
  const count = readU32(v, off + 8), flags = readU32(v, off + 16), start = readU32(v, off + 20), utf8 = (flags & 0x100) !== 0, base = off + start;
  const offs = Array.from({ length: count }, (_, i) => readU32(v, off + 28 + i * 4));
  return (idx: number) => {
    if (idx < 0 || idx >= offs.length) return "";
    let p = base + offs[idx];
    if (utf8) { const a = readLen8(buf, p), b = readLen8(buf, a[1]); return new TextDecoder().decode(buf.slice(b[1], b[1] + a[0])); }
    const a = readLen16(v, p); return new TextDecoder("utf-16le").decode(buf.slice(a[1], a[1] + a[0] * 2));
  };
}
function parseApkManifest(buf: Uint8Array) {
  try {
    const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    if (buf.length < 8 || readU16(v, 0) !== 3) return {};
    let p = 8, strings: any = null, packageName = "", versionCode: number | undefined, versionName: string | undefined;
    while (p + 8 <= buf.length) {
      const type = readU16(v, p), size = readU32(v, p + 4); if (size < 8 || p + size > buf.length) break;
      if (type === 1) strings = axmlStrings(buf, v, p);
      else if (type === 0x102 && strings && p + 36 <= buf.length) {
        const attrStart = readU16(v, p + 24), attrSize = readU16(v, p + 26), attrCount = readU16(v, p + 28), attrs = p + 16 + attrStart;
        for (let i = 0; i < attrCount; i++) {
          const q = attrs + i * attrSize; if (q + 20 > p + size) break;
          const name = strings(readU32(v, q + 4)), raw = readU32(v, q + 8), dataType = buf[q + 15], data = readU32(v, q + 16), value = raw === 0xffffffff ? "" : strings(raw);
          if (name === "package") packageName = value || packageName;
          if (name === "versionName") versionName = value;
          if (name === "versionCode") versionCode = dataType === 0x10 || dataType === 0x11 ? data : Number(value);
        }
      }
      p += size;
    }
    return { packageName, versionCode, versionName };
  } catch { return {}; }
}

async function archiveBinaries(data: Uint8Array) {
  if (data.length < 22) return [];
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const u16 = (p: number) => view.getUint16(p, true);
  const u32 = (p: number) => view.getUint32(p, true);
  const end = Math.max(0, data.length - 65558);
  for (let p = data.length - 22; p >= end; p--) {
    if (u32(p) !== 0x06054b50) continue;
    const count = u16(p + 10);
    let cursor = u32(p + 16);
    if (cursor >= data.length) return [];
    const found: Array<{ name: string; bytes: Uint8Array; packageName?: string; versionCode?: number; versionName?: string }> = [];
    for (let i = 0; i < count && cursor + 46 <= data.length; i++) {
      if (u32(cursor) !== 0x02014b50) break;
      const method = u16(cursor + 10), compressed = u32(cursor + 20), size = u32(cursor + 24);
      const nameLength = u16(cursor + 28), extraLength = u16(cursor + 30), commentLength = u16(cursor + 32), local = u32(cursor + 42);
      if (cursor + 46 + nameLength + extraLength + commentLength > data.length) break;
      const fullName = new TextDecoder().decode(data.slice(cursor + 46, cursor + 46 + nameLength));
      cursor += 46 + nameLength + extraLength + commentLength;
      const kind = artifactKind(fullName);
      const limit = (kind === "exe" ? 450 : 100) * 1024 * 1024;
      if (!kind || size > limit || compressed > limit) continue;
      if (local + 30 > data.length) continue;
      const localName = u16(local + 26), localExtra = u16(local + 28);
      const dataStart = local + 30 + localName + localExtra;
      if (dataStart + compressed > data.length) continue;
      const raw = data.slice(dataStart, dataStart + compressed);
      let bytes: Uint8Array | null = null;
      if (method === 0) bytes = raw.byteLength <= limit ? raw : null;
      else if (method === 8) bytes = await inflateBounded(raw, limit);
      if (!bytes) continue;
      const metadata = kind === "apk" ? await apkMetadata(bytes) : {};
      if (kind === "apk" && !metadata.packageName) continue;
      found.push({
        name: fullName.split("/").pop() || `application.${kind}`,
        bytes,
        packageName: metadata.packageName,
        versionCode: metadata.versionCode,
        versionName: metadata.versionName,
      });
    }
    return found;
  }
  return [];
}

async function sha256(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

type ApkRetentionEntry = { sourceId: string; code: number; date: number };

async function loadApkRetentionBuckets(sb: any, applicationId: number): Promise<Map<string, ApkRetentionEntry[]>> {
  const buckets = new Map<string, ApkRetentionEntry[]>();
  const result = await sb.from("artifacts")
    .select("filename,package_identity,version_code,source_updated_at,signing_status,releases!inner(id,source_release_id,channel,version_code,published_at,created_at,application_id)")
    .eq("platform", "android").eq("kind", "apk").eq("releases.application_id", applicationId);
  if (result.error) throw result.error;
  const byBucket = new Map<string, Map<string, ApkRetentionEntry>>();
  for (const artifact of result.data || []) {
    if (artifact.signing_status === "failed" || artifact.signing_status === "processing") continue;
    const release = Array.isArray(artifact.releases) ? artifact.releases[0] : artifact.releases;
    if (!release) continue;
    const channel = String(release.channel || "development");
    const variant = apkVariantKey(String(artifact.filename || ""), String(artifact.package_identity || ""));
    const bucketKey = `${channel}::${variant}`;
    const sourceId = String(release.source_release_id || release.id);
    const code = Math.max(Number(artifact.version_code || 0), Number(release.version_code || 0));
    const date = Math.max(
      Date.parse(artifact.source_updated_at || "") || 0,
      Date.parse(release.published_at || release.created_at || "") || 0,
    );
    const entries = byBucket.get(bucketKey) || new Map<string, ApkRetentionEntry>();
    const prev = entries.get(sourceId);
    entries.set(sourceId, {
      sourceId,
      code: Math.max(prev?.code || 0, code),
      date: Math.max(prev?.date || 0, date),
    });
    byBucket.set(bucketKey, entries);
  }
  for (const [bucketKey, entries] of byBucket.entries()) {
    buckets.set(bucketKey, [...entries.values()].sort((a, b) => (b.code - a.code) || (b.date - a.date)));
  }
  return buckets;
}

function wouldKeepApk(
  buckets: Map<string, ApkRetentionEntry[]>,
  channel: string,
  filename: string,
  packageName: string,
  versionCode: number,
  dateMs: number,
  sourceId: string,
): boolean {
  const key = `${channel}::${apkVariantKey(filename, packageName)}`;
  const list = buckets.get(key) || [];
  if (list.some((x) => x.sourceId === sourceId)) return true;
  if (list.length < 2) return true;
  const second = list[1];
  return versionCode > second.code || (versionCode === second.code && dateMs >= second.date);
}

function recordKeptApk(
  buckets: Map<string, ApkRetentionEntry[]>,
  channel: string,
  filename: string,
  packageName: string,
  versionCode: number,
  dateMs: number,
  sourceId: string,
) {
  const key = `${channel}::${apkVariantKey(filename, packageName)}`;
  const list = buckets.get(key) || [];
  const idx = list.findIndex((x) => x.sourceId === sourceId);
  const entry = { sourceId, code: versionCode, date: dateMs };
  if (idx >= 0) {
    list[idx] = {
      sourceId,
      code: Math.max(list[idx].code, entry.code),
      date: Math.max(list[idx].date, entry.date),
    };
  } else {
    list.push(entry);
  }
  list.sort((a, b) => (b.code - a.code) || (b.date - a.date));
  buckets.set(key, list);
}

function compactPrunedCache(cache: Record<string, string>): Record<string, string> {
  const entries = Object.entries(cache);
  if (entries.length <= 250) return cache;
  return Object.fromEntries(entries.slice(entries.length - 250));
}

async function retainCurrentAndPreviousApks(sb: any, applicationId: number) {
  const result = await sb.from("artifacts")
    .select("id,filename,download_url,release_id,package_identity,version_code,source_updated_at,signing_status,releases!inner(id,channel,version_code,version_name,published_at,created_at,application_id)")
    .eq("platform", "android").eq("kind", "apk").eq("releases.application_id", applicationId);
  if (result.error) throw result.error;

  // Group independently by (channel, package_identity + ABI variant) so multi-package
  // repositories (e.g. launcher + runner) and phone vs x86_64 builds never evict one another.
  const byBucket = new Map<string, Map<string, { code: number; date: number; rows: any[] }>>();
  for (const artifact of result.data || []) {
    if (artifact.signing_status === "failed" || artifact.signing_status === "processing") continue;
    const release = Array.isArray(artifact.releases) ? artifact.releases[0] : artifact.releases;
    if (!release) continue;
    const channel = String(release.channel || "development");
    const variant = apkVariantKey(String(artifact.filename || ""), String(artifact.package_identity || ""));
    const bucketKey = `${channel}::${variant}`;
    const groups = byBucket.get(bucketKey) || new Map<string, { code: number; date: number; rows: any[] }>();
    const key = String(release.id);
    const versionCode = Math.max(Number(artifact.version_code || 0), Number(release.version_code || 0));
    const date = Math.max(
      Date.parse(artifact.source_updated_at || "") || 0,
      Date.parse(release.published_at || release.created_at || "") || 0,
    );
    const group = groups.get(key) || { code: 0, date: 0, rows: [] };
    group.code = Math.max(group.code, versionCode);
    group.date = Math.max(group.date, date);
    group.rows.push(artifact);
    groups.set(key, group);
    byBucket.set(bucketKey, groups);
  }

  const keepIds = new Set<number>();
  const allRows: any[] = [];
  for (const [, groups] of byBucket.entries()) {
    const ordered = [...groups.entries()].sort((a, b) => b[1].code - a[1].code || b[1].date - a[1].date);
    for (const [, group] of ordered.slice(0, 2)) {
      for (const row of group.rows) keepIds.add(Number(row.id));
    }
    for (const [, group] of ordered) allRows.push(...group.rows);
  }
  const obsoleteRows = allRows.filter((row) => !keepIds.has(Number(row.id)));
  const touchedReleaseIds = new Set<number>(obsoleteRows.map((row) => Number(row.release_id)));

  const removals = obsoleteRows.map((artifact) => {
    try {
      const url = new URL(String(artifact.download_url || ""));
      const marker = "/storage/v1/object/public/aem-artifacts/";
      const index = url.pathname.indexOf(marker);
      if (index < 0) return null;
      return { id: artifact.id, release_id: Number(artifact.release_id), path: decodeURIComponent(url.pathname.slice(index + marker.length)) };
    } catch {
      return null;
    }
  }).filter(Boolean) as Array<{ id: number; release_id: number; path: string }>;

  if (removals.length) {
    const removed = await sb.storage.from("aem-artifacts").remove(removals.map((x) => x.path));
    if (removed.error) throw new Error(`APK retention could not remove obsolete objects: ${removed.error.message}`);
    const deleted = await sb.from("artifacts").delete().in("id", removals.map((x) => x.id));
    if (deleted.error) throw new Error(`APK retention could not remove obsolete artifact records: ${deleted.error.message}`);
  }

  // Clean up orphaned empty release rows so they do not bloat catalog queries or block re-sync.
  const relRes = await sb.from("releases").select("id,source_release_id").eq("application_id", applicationId);
  if (!relRes.error && Array.isArray(relRes.data)) {
    const { data: remainingArts } = await sb.from("artifacts").select("release_id").in("release_id", relRes.data.map((r: any) => r.id));
    const hasArtifacts = new Set<number>((remainingArts || []).map((a: any) => Number(a.release_id)));
    for (const rel of relRes.data) {
      const relId = Number(rel.id);
      if (!hasArtifacts.has(relId) && (touchedReleaseIds.has(relId) || String(rel.source_release_id || "").startsWith("github-actions-artifact-"))) {
        await sb.from("applications").update({ rollback_release_id: null }).eq("id", applicationId).eq("rollback_release_id", relId);
        await sb.from("releases").delete().eq("id", relId);
      }
    }
  }
  return removals.length;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (request.method !== "POST") return json({ error: "POST required" }, 405);
  const sb = client();
  const started = new Date();
  try {
    const supplied = (request.headers.get("x-aem-sync-secret") || "").trim();
    const secret = await sb.rpc("aem_get_sync_secret");
    if (secret.error || !secret.data || !(await constantTimeEqual(supplied, String(secret.data)))) {
      return json({ ok: false, error: "Unauthorized sync caller." }, 401);
    }
    const token = (Deno.env.get("AEM_GITHUB_TOKEN") || Deno.env.get("GITHUB_TOKEN") || "").trim();
    if (!token) return json({ ok: false, error: "AEM_GITHUB_TOKEN is not configured." }, 503);
    const headers = { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" };
    const user = await gh(`${GH}/user`, headers);
    if (user.login !== "Emmanuel001afk") return json({ error: "GitHub token is not for Emmanuel001afk." }, 403);

    const state = (await sb.from("source_sync_state").select("status,last_started_at,last_success_at,repositories_scanned,applications_discovered,releases_discovered,artifacts_discovered,last_error").eq("provider", "github").maybeSingle()).data;
    const providerRow = (await sb.from("source_providers").select("config").eq("id", "github").maybeSingle()).data;
    const providerConfig = (providerRow?.config && typeof providerRow.config === "object") ? { ...providerRow.config } : {};
    const continuing = state?.status === "running";
    const batchActive = Boolean(providerConfig.batch_active);
    const prunedCache: Record<string, string> = (providerConfig.pruned_cache && typeof providerConfig.pruned_cache === "object")
      ? Object.fromEntries(Object.entries(providerConfig.pruned_cache as Record<string, unknown>).map(([k, v]) => [k, String(v || "")]))
      : {};
    const now = Date.now(), lastSuccess = state?.last_success_at ? Date.parse(state.last_success_at) : 0;
    const lastStart = state?.last_started_at ? Date.parse(state.last_started_at) : 0;
    if (continuing && batchActive && now - lastStart < 120000) return json({ ok: true, throttled: true });
    if (!continuing && lastSuccess && now - lastSuccess < 30000) return json({ ok: true, throttled: true, last_success_at: state?.last_success_at });
    await sb.from("source_providers").update({ config: { ...providerConfig, batch_active: true, pruned_cache: compactPrunedCache(prunedCache) }, updated_at: started.toISOString() }).eq("id", "github");
    await sb.from("source_sync_state").upsert({ provider: "github", status: "running", last_started_at: started.toISOString(), last_error: continuing ? state.last_error : null, updated_at: started.toISOString() }, { onConflict: "provider" });

    const repositories: any[] = [];
    for (let page = 1; ; page++) {
      const batch = await gh(`${GH}/user/repos?visibility=all&affiliation=owner,collaborator,organization_member&sort=created&direction=asc&per_page=100&page=${page}`, headers);
      repositories.push(...batch);
      if (batch.length < 100) break;
    }
    repositories.sort((a, b) => Number(a.id) - Number(b.id));

    const lastCursorId = continuing ? Number(providerConfig.cursor_repo_id || 0) : 0;
    const startIndex = continuing && lastCursorId > 0
      ? Math.max(0, repositories.findIndex((r) => Number(r.id) > lastCursorId))
      : 0;
    const noMoreRepos = continuing && lastCursorId > 0 && repositories.every((r) => Number(r.id) <= lastCursorId);
    const batchRepositories = noMoreRepos ? [] : repositories.slice(startIndex, startIndex + MAX_SYNC_REPOSITORIES_PER_INVOCATION);

    const totals = {
      applications: continuing ? Number(state.applications_discovered || 0) : 0,
      releases: continuing ? Number(state.releases_discovered || 0) : 0,
      artifacts: continuing ? Number(state.artifacts_discovered || 0) : 0,
      failures: 0,
    };
    const priorFailures = continuing ? previousFailures(state.last_error) : { count: 0, details: [] as string[] };
    const failureDetails = priorFailures.details;
    totals.failures = priorFailures.count;

    let lastScannedRepoId = lastCursorId;
    for (let repoOffset = 0; repoOffset < batchRepositories.length; repoOffset++) {
      const repo = batchRepositories[repoOffset];
      lastScannedRepoId = Number(repo.id);
      try {
        const tree = await gh(`${GH}/repos/${repo.full_name}/git/trees/${repo.default_branch || "main"}?recursive=1`, headers).catch(() => ({ tree: [] }));
        const treeFiles = (tree.tree || []).filter((x: any) => x.type === "blob" && artifactKind(String(x.path)) && Number(x.size || 0) <= 50 * 1024 * 1024 && !/(^|\/)(tests?|fixtures?|samples?)\//i.test(String(x.path)));
        const sourceFiles: any[] = [];
        for (const plat of ["android", "windows"]) {
          const file = treeFiles.find((x: any) => platform(artifactKind(String(x.path)) || "") === plat);
          if (file) sourceFiles.push(file);
        }
        const releaseRows = await gh(`${GH}/repos/${repo.full_name}/releases?per_page=50`, headers).catch(() => []);
        const sortedReleases = Array.isArray(releaseRows) ? releaseRows
          .filter((r: any) => !r.draft && (r.assets || []).some((a: any) => artifactKind(a.name)))
          .sort((a: any, b: any) => releaseActivity(b) - releaseActivity(a)) : [];
        const pickedReleases = new Map<number, any>();
        for (const r of sortedReleases.slice(0, 4)) pickedReleases.set(Number(r.id), r);
        for (const plat of ["android", "windows"]) {
          const match = sortedReleases.find((r: any) => (r.assets || []).some((a: any) => {
            const k = artifactKind(String(a.name));
            return k !== null && platform(k) === plat;
          }));
          if (match) pickedReleases.set(Number(match.id), match);
        }
        const releases = [...pickedReleases.values()].sort((a: any, b: any) => releaseActivity(b) - releaseActivity(a));
        const runs = await gh(`${GH}/repos/${repo.full_name}/actions/runs?status=success&per_page=10`, headers).catch(() => ({ workflow_runs: [] }));
        const actionRuns = (runs.workflow_runs || []).filter((run: any) =>
          run.head_branch === (repo.default_branch || "main")
        ).slice(0, 5);
        const platforms = new Set<string>(sourceFiles.map((f: any) => platform(artifactKind(String(f.path)) || "")));
        for (const release of releases) for (const asset of release.assets || []) {
          const kind = artifactKind(String(asset.name)); if (kind) platforms.add(platform(kind));
        }
        const appResult = await sb.from("applications").select("id,project,name,package_identity,platforms,description_source,icon_source")
          .eq("provider", "github").eq("project", repo.full_name).maybeSingle();
        if (appResult.error) throw appResult.error;
        let app = appResult.data;
        const apkBuckets = app?.id ? await loadApkRetentionBuckets(sb, Number(app.id)) : new Map<string, ApkRetentionEntry[]>();
        const actionCandidates: Array<{ run: any; item: any; binaries: any[] }> = [];
        let inspectedActionArtifacts = 0, downloadedArchiveBytes = 0, discoveredBinaryBytes = 0;
        for (const run of actionRuns) {
          if (inspectedActionArtifacts >= MAX_WORKFLOW_ARTIFACTS_PER_REPO || downloadedArchiveBytes >= MAX_WORKFLOW_ARCHIVE_BYTES_PER_REPO || discoveredBinaryBytes >= MAX_DISCOVERED_BINARY_BYTES_PER_REPO) break;
          const publishedRun = app && await sb.from("releases").select("id").eq("application_id", app.id).eq("source_release_id", `github-actions-${run.id}`).maybeSingle();
          const items = await gh(`${GH}/repos/${repo.full_name}/actions/runs/${run.id}/artifacts?per_page=100&direction=desc`, headers).catch(() => ({ artifacts: [] }));
          for (const item of items.artifacts || []) {
            if (inspectedActionArtifacts >= MAX_WORKFLOW_ARTIFACTS_PER_REPO || downloadedArchiveBytes >= MAX_WORKFLOW_ARCHIVE_BYTES_PER_REPO || discoveredBinaryBytes >= MAX_DISCOVERED_BINARY_BYTES_PER_REPO) break;
            if (publishedRun?.data && String(item.name || "") === "aem-store-release-apk") continue;
            const archiveSize = Number(item.size_in_bytes || 0);
            if (item.expired || archiveSize <= 0 || archiveSize > 35 * 1024 * 1024 || downloadedArchiveBytes + archiveSize > MAX_WORKFLOW_ARCHIVE_BYTES_PER_REPO) continue;
            const releaseId = `github-actions-artifact-${item.id}`;
            const actionStamp = String(item.updated_at || item.created_at || "");
            if (actionStamp && prunedCache[releaseId] === actionStamp) continue;
            const existing = app && await sb.from("releases").select("id").eq("application_id", app.id).eq("source_release_id", releaseId).maybeSingle();
            if (existing?.error) throw existing.error;
            if (existing?.data) {
              const existingArts = await sb.from("artifacts").select("id,platform,package_identity,source_updated_at,artifact_version_name").eq("release_id", existing.data.id);
              if (existingArts.error) throw existingArts.error;
              const rows = existingArts.data || [];
              if (rows.length > 0 && rows.every((r: any) => Boolean(r.source_updated_at) && !(r.platform === "windows" && String(r.package_identity || "").startsWith("github:")))) {
                continue;
              }
            }
            inspectedActionArtifacts++;
            const response = await fetch(item.archive_download_url, { headers });
            if (!response.ok || Number(response.headers.get("content-length") || 0) > 40 * 1024 * 1024) continue;
            const archive = new Uint8Array(await response.arrayBuffer());
            downloadedArchiveBytes += archive.byteLength;
            const binaries = await archiveBinaries(archive);
            const supported: any[] = [];
            const itemUpdatedMs = Date.parse(String(item.updated_at || item.created_at || run.updated_at || run.created_at || "")) || 0;
            let prunedAny = false;
            for (const binary of binaries) {
              const kind = artifactKind(binary.name);
              if (!kind || binary.bytes.byteLength > 50 * 1024 * 1024 || discoveredBinaryBytes + binary.bytes.byteLength > MAX_DISCOVERED_BINARY_BYTES_PER_REPO) continue;
              if (kind === "apk") {
                const vc = Number(binary.versionCode || 0);
                if (!wouldKeepApk(apkBuckets, "development", binary.name, String(binary.packageName || ""), vc, itemUpdatedMs, releaseId)) {
                  prunedAny = true;
                  continue;
                }
                recordKeptApk(apkBuckets, "development", binary.name, String(binary.packageName || ""), vc, itemUpdatedMs, releaseId);
              }
              supported.push(binary);
              discoveredBinaryBytes += binary.bytes.byteLength;
              platforms.add(platform(kind));
            }
            if (supported.length) {
              delete prunedCache[releaseId];
              actionCandidates.push({ run, item, binaries: supported });
            } else if (prunedAny && actionStamp) {
              prunedCache[releaseId] = actionStamp;
            }
          }
        }
        if (!platforms.size) continue;
        const patch: any = {
          provider: "github", project: repo.full_name, source_external_id: String(repo.id),
          source_visibility: repo.private ? "private" : "public",
          name: app?.name && app.name !== "Application" ? app.name : repo.name === "AEM" ? "AEM Store" : repo.name === "phormi-android" ? "Phormi" : repo.name,
          description: repo.description || null, description_source: "github", source_url: repo.html_url,
          icon_url: repo.owner?.avatar_url || null, icon_source: "github-avatar",
          platforms: Array.from(new Set([...(app?.platforms || []), ...platforms])), updated_at: new Date().toISOString(),
        };
        if (app?.description_source === "manual") { delete patch.description; delete patch.description_source; }
        if (app?.icon_source === "manual") { delete patch.icon_url; delete patch.icon_source; }
        if (!app) {
          const inserted = await sb.from("applications").insert(patch).select("id,project,name,package_identity,platforms,description_source,icon_source").single();
          if (inserted.error) throw inserted.error; app = inserted.data; totals.applications++;
        } else {
          const updated = await sb.from("applications").update(patch).eq("id", app.id).select("id,project,name,package_identity,platforms,description_source,icon_source").single();
          if (updated.error) throw updated.error; app = updated.data;
        }
        if (!app) throw new Error(`Could not register ${repo.full_name} in the AEM catalog.`);

        const save = async (release: any, filename: string, bytes: Uint8Array, kind: string, path: string, metadata: any = {}, source: any = {}) => {
          const upload = await sb.storage.from("aem-artifacts").upload(path, bytes, {
            contentType: kind === "apk" ? "application/vnd.android.package-archive" : kind === "exe" ? "application/vnd.microsoft.portable-executable" : "application/octet-stream",
            upsert: true,
          });
          if (upload.error) throw upload.error;
          const hash = await sha256(bytes);
          const exeVersion = kind === "exe" ? (metadata.versionName || extractExeVersion(bytes, filename, String(release.version_name || source.releaseName || ""))) : null;
          const payload = {
            release_id: release.id, platform: platform(kind), kind, filename,
            download_url: `${Deno.env.get("SUPABASE_URL")}/storage/v1/object/public/aem-artifacts/${path}`,
            size_bytes: bytes.byteLength, sha256: hash,
            source_sha256: source.sha256 || hash,
            source_updated_at: source.updatedAt || null,
            artifact_version_name: kind === "exe" ? exeVersion : (metadata.versionName || null),
            package_identity: kind === "exe" ? sanitizeWindowsIdentity(app!.package_identity, app!.project) : metadata.packageName || app!.package_identity || null,
            version_code: metadata.versionCode ?? null,
            signing_status: kind === "apk" ? "pending" : "ready",
          };
          const prior = await sb.from("artifacts").select("id").eq("release_id", release.id).eq("filename", filename).maybeSingle();
          const result = prior.data ? await sb.from("artifacts").update(payload).eq("id", prior.data.id) : await sb.from("artifacts").insert(payload);
          if (result.error) throw result.error; totals.artifacts++;
          if (metadata.packageName && !app!.package_identity) {
            app!.package_identity = metadata.packageName;
            await sb.from("applications").update({ package_identity: metadata.packageName, updated_at: new Date().toISOString() }).eq("id", app!.id);
          }
          if (kind === "apk" && Number.isInteger(metadata.versionCode) && Number(metadata.versionCode) > Number(release.version_code || 0)) {
            release.version_code = Number(metadata.versionCode);
            await sb.from("releases").update({ version_code: Number(metadata.versionCode) }).eq("id", release.id);
          }
          if (source.updatedAt) {
            const relTs = release.published_at ? Date.parse(release.published_at) : 0;
            const srcTs = Date.parse(source.updatedAt) || 0;
            if (srcTs > relTs) {
              release.published_at = source.updatedAt;
              await sb.from("releases").update({ published_at: source.updatedAt }).eq("id", release.id);
            }
          }
          const detected = platform(kind);
          if (!(app!.platforms || []).includes(detected)) {
            app!.platforms = [...(app!.platforms || []), detected];
            await sb.from("applications").update({ platforms: app!.platforms, updated_at: new Date().toISOString() }).eq("id", app!.id);
          }
        };
        const ensureRelease = async (sourceId: string, name: string, channel: string, title: string, date: string) => {
          const found = await sb.from("releases").select("id,version_name,version_code,published_at").eq("application_id", app!.id).eq("source_release_id", sourceId).maybeSingle();
          if (found.data) return found.data;
          const created = await sb.from("releases").insert({
            application_id: app!.id, source_release_id: sourceId, version_name: name,
            channel: releaseChannel(channel), status: "published", title, published_at: date,
          }).select("id,version_name,version_code,published_at").single();
          if (created.error) throw created.error; totals.releases++; return created.data;
        };

        for (const release of releases) {
          const name = String(release.tag_name || release.name || "unknown"), id = `github-release-${release.id}`;
          const existingRelease = await sb.from("releases").select("id").eq("application_id", app.id).eq("source_release_id", id).maybeSingle();
          if (existingRelease.error) throw existingRelease.error;
          const validAssets: Array<{ asset: any; kind: string; bytes?: Uint8Array; metadata: any; digest?: string; external?: boolean; sourceUpdatedAt?: string | null }> = [];
          for (const asset of (release.assets || []).filter((x: any) => artifactKind(String(x.name)) && Number(x.size || 0) <= 300 * 1024 * 1024)) {
            const kind = artifactKind(String(asset.name))!;
            const size = Number(asset.size || 0);
            const digest = String(asset.digest || "").replace(/^sha256:/i, "").toLowerCase();
            const sourceUpdatedAt = asset.updated_at || release.published_at || release.created_at || null;
            const hasSourceDigest = /^[a-f0-9]{64}$/.test(digest);
            if (existingRelease.data) {
              const cached = await sb.from("artifacts").select("id,source_sha256,source_updated_at,package_identity,artifact_version_name,signing_status")
                .eq("release_id", existingRelease.data.id).eq("filename", String(asset.name)).maybeSingle();
              if (cached.error) throw cached.error;
              const cachedUpdatedAt = cached.data?.source_updated_at ? Date.parse(cached.data.source_updated_at) : 0;
              const currentUpdatedAt = sourceUpdatedAt ? Date.parse(sourceUpdatedAt) : 0;
              const unchanged = hasSourceDigest
                ? cached.data?.source_sha256 === digest
                : Boolean(cachedUpdatedAt && currentUpdatedAt && cachedUpdatedAt === currentUpdatedAt);
              if (unchanged) {
                if (kind === "exe" && (String(cached.data?.package_identity || "").startsWith("github:") || !cached.data?.artifact_version_name)) {
                  const healedVer = cached.data?.artifact_version_name || extractExeVersion(undefined, String(asset.name), name);
                  await sb.from("artifacts").update({
                    package_identity: sanitizeWindowsIdentity(app.package_identity, app.project),
                    artifact_version_name: healedVer,
                  }).eq("id", cached.data!.id);
                }
                continue;
              }
            }
            if (kind === "exe" && !repo.private && size > 50 * 1024 * 1024 && /^[a-f0-9]{64}$/.test(digest)) {
              validAssets.push({ asset, kind, metadata: { versionName: extractExeVersion(undefined, String(asset.name), name) }, digest, sourceUpdatedAt });
              continue;
            }
            const pruneKey = `${id}::${String(asset.name)}`;
            const assetStamp = hasSourceDigest ? digest : String(sourceUpdatedAt || "");
            if (kind === "apk" && assetStamp && prunedCache[pruneKey] === assetStamp) continue;
            const oversizedPublicApk = kind === "apk" && !repo.private && size > 50 * 1024 * 1024 && size <= MAX_PUBLIC_RELEASE_APK_BYTES;
            if (size > 50 * 1024 * 1024 && !oversizedPublicApk) continue;
            const response = await fetch(asset.browser_download_url, { headers }); if (!response.ok) continue;
            const bytes = new Uint8Array(await response.arrayBuffer());
            const metadata = kind === "apk" ? await apkMetadata(bytes) : { versionName: extractExeVersion(bytes, String(asset.name), name) };
            if (kind === "apk" && (!metadata.packageName || (oversizedPublicApk && !apkHasSignature(bytes)))) continue;
            if (kind === "apk") {
              const ch = releaseChannel(name);
              const vc = Number(metadata.versionCode || 0);
              const ts = Date.parse(String(sourceUpdatedAt || release.published_at || release.created_at || "")) || 0;
              if (!wouldKeepApk(apkBuckets, ch, String(asset.name), String(metadata.packageName || ""), vc, ts, id)) {
                if (assetStamp) prunedCache[pruneKey] = assetStamp;
                continue;
              }
              delete prunedCache[pruneKey];
              recordKeptApk(apkBuckets, ch, String(asset.name), String(metadata.packageName || ""), vc, ts, id);
            }
            if (oversizedPublicApk) {
              validAssets.push({ asset, kind, metadata, digest: /^[a-f0-9]{64}$/.test(digest) ? digest : undefined, external: true, sourceUpdatedAt });
            } else {
              validAssets.push({ asset, kind, bytes, metadata, digest: hasSourceDigest ? digest : undefined, sourceUpdatedAt });
            }
          }
          if (!validAssets.length) continue;
          const row = await ensureRelease(id, name, name, release.name || name, release.published_at || release.created_at);
          for (const item of validAssets) {
            const { asset, kind, bytes, metadata, digest, sourceUpdatedAt } = item;
            if (kind === "exe" && !repo.private && Number(asset.size || 0) > 50 * 1024 * 1024 && digest) {
              const payload = {
                release_id: row.id, platform: "windows", kind, filename: String(asset.name), download_url: asset.browser_download_url,
                size_bytes: Number(asset.size), sha256: digest, source_sha256: digest, source_updated_at: sourceUpdatedAt,
                artifact_version_name: metadata.versionName || extractExeVersion(undefined, String(asset.name), name),
                package_identity: sanitizeWindowsIdentity(app.package_identity, repo.full_name), signing_status: "ready",
              };
              const prior = await sb.from("artifacts").select("id").eq("release_id", row.id).eq("filename", String(asset.name)).maybeSingle();
              const result = prior.data ? await sb.from("artifacts").update(payload).eq("id", prior.data.id) : await sb.from("artifacts").insert(payload);
              if (result.error) throw result.error;
              totals.artifacts++;
            } else if (kind === "apk" && item.external) {
              const payload = {
                release_id: row.id, platform: "android", kind, filename: String(asset.name), download_url: asset.browser_download_url,
                size_bytes: Number(asset.size), sha256: digest || null, source_sha256: digest || null, source_updated_at: sourceUpdatedAt,
                artifact_version_name: metadata.versionName || null,
                package_identity: metadata.packageName || app!.package_identity || null,
                version_code: metadata.versionCode ?? null, signing_status: "ready",
              };
              const prior = await sb.from("artifacts").select("id").eq("release_id", row.id).eq("filename", String(asset.name)).maybeSingle();
              const result = prior.data ? await sb.from("artifacts").update(payload).eq("id", prior.data.id) : await sb.from("artifacts").insert(payload);
              if (result.error) throw result.error;
              totals.artifacts++;
              if (metadata.packageName && !app!.package_identity) {
                app!.package_identity = metadata.packageName;
                await sb.from("applications").update({ package_identity: metadata.packageName, updated_at: new Date().toISOString() }).eq("id", app!.id);
              }
              if (Number.isInteger(metadata.versionCode) && Number(metadata.versionCode) > Number(row.version_code || 0)) {
                row.version_code = Number(metadata.versionCode);
                await sb.from("releases").update({ version_code: Number(metadata.versionCode) }).eq("id", row.id);
              }
              if (sourceUpdatedAt && (Date.parse(sourceUpdatedAt) || 0) > (row.published_at ? Date.parse(row.published_at) : 0)) {
                row.published_at = sourceUpdatedAt;
                await sb.from("releases").update({ published_at: sourceUpdatedAt }).eq("id", row.id);
              }
            } else if (bytes) {
              await save(row, String(asset.name), bytes, kind, `${repo.full_name}/${safeName(name)}/${safeName(String(asset.name))}`, metadata,
                { sha256: digest, updatedAt: sourceUpdatedAt, releaseName: name });
            }
          }
        }
        for (const file of sourceFiles) {
          const id = `github-file-${file.sha}`;
          const exists = await sb.from("releases").select("id").eq("application_id", app.id).eq("source_release_id", id).maybeSingle();
          if (exists.data) continue;
          const path = String(file.path), kind = artifactKind(path)!;
          const response = await fetch(`https://raw.githubusercontent.com/${repo.full_name}/${repo.default_branch || "main"}/${path.split("/").map(encodeURIComponent).join("/")}`, { headers });
          if (!response.ok) continue;
          const bytes = new Uint8Array(await response.arrayBuffer());
          const metadata = kind === "apk" ? await apkMetadata(bytes) : {};
          if (kind === "apk" && !metadata.packageName) continue;
          const created = await ensureRelease(id, "Repository binary", "development", path, new Date().toISOString());
          await save(created, path.split("/").pop() || `application.${kind}`, bytes, kind,
            `${repo.full_name}/source/${file.sha}/${safeName(path.split("/").pop() || "application")}`, metadata);
        }
        for (const { run, item, binaries } of actionCandidates) {
          const id = `github-actions-artifact-${item.id}`;
          const runLabel = run.run_number || item.workflow_run?.run_number || item.id;
          const createdAt = item.created_at || run.updated_at || run.created_at;
          const row = await ensureRelease(id, `workflow-${runLabel}`, "development", String(item.name || "GitHub Actions artifact"), createdAt);
          for (const binary of binaries) {
            const kind = artifactKind(binary.name);
            if (kind) await save(row, binary.name, binary.bytes, kind,
              `${repo.full_name}/actions/${item.id}/${safeName(binary.name)}`, binary,
              { updatedAt: item.updated_at || item.created_at || run.updated_at || run.created_at });
          }
        }
        await retainCurrentAndPreviousApks(sb, Number(app.id));
      } catch (error) {
        totals.failures++;
        const issue = error as any;
        const detail = `${repo.full_name}: ${issue?.message || JSON.stringify(issue) || String(error)}`;
        failureDetails.push(detail.slice(0, 500));
        console.error("Repository discovery failed", detail);
      } finally {
        const progress = startIndex + repoOffset + 1;
        await sb.from("source_providers").update({
          config: { ...providerConfig, cursor_repo_id: lastScannedRepoId, batch_active: false, pruned_cache: compactPrunedCache(prunedCache) },
          updated_at: new Date().toISOString(),
        }).eq("id", "github");
        await sb.from("source_sync_state").update({
          status: "running", repositories_scanned: progress,
          applications_discovered: totals.applications, releases_discovered: totals.releases,
          artifacts_discovered: totals.artifacts,
          last_error: totals.failures ? JSON.stringify({ count: totals.failures, details: failureDetails.slice(-7) }).slice(0, 4000) : null,
          updated_at: new Date().toISOString(),
        }).eq("provider", "github");
      }
    }
    const finished = new Date().toISOString();
    const nextIndex = noMoreRepos ? repositories.length : Math.min(startIndex + batchRepositories.length, repositories.length);
    const complete = noMoreRepos || nextIndex >= repositories.length;
    await sb.from("source_providers").update({
      config: { ...providerConfig, cursor_repo_id: complete ? 0 : lastScannedRepoId, batch_active: false, pruned_cache: compactPrunedCache(prunedCache) },
      updated_at: finished,
    }).eq("id", "github");
    const status = complete ? (totals.failures ? "partial" : "success") : "running";
    const error = failureDetails.length ? failureDetails.join("; ").slice(0, 4000) : null;
    const stateWrite = await sb.from("source_sync_state").upsert({
      provider: "github", status, last_started_at: started.toISOString(),
      last_success_at: status === "success" ? finished : state?.last_success_at || null,
      last_error: error, repositories_scanned: complete ? repositories.length : nextIndex,
      applications_discovered: totals.applications, releases_discovered: totals.releases,
      artifacts_discovered: totals.artifacts, updated_at: finished,
    }, { onConflict: "provider" });
    if (stateWrite.error) return json({ ok: false, error: `Could not save sync status: ${stateWrite.error.message}`, scanned: repositories.length });
    return json({
      ok: true, partial: totals.failures > 0, scan_complete: complete, cursor: complete ? 0 : nextIndex,
      authenticated_as: user.login, scanned: repositories.length, processed: batchRepositories.length,
      failed_repositories: totals.failures, failure_details: failureDetails, discovered: totals.applications,
      releases: totals.releases, artifacts: totals.artifacts,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const existingCfg = (await sb.from("source_providers").select("config").eq("id", "github").maybeSingle()).data?.config;
    const cfgObj = existingCfg && typeof existingCfg === "object" ? existingCfg : {};
    await sb.from("source_providers").update({ config: { ...cfgObj, batch_active: false }, updated_at: new Date().toISOString() }).eq("id", "github");
    await sb.from("source_sync_state").upsert({ provider: "github", status: "failed", last_error: message, updated_at: new Date().toISOString() }, { onConflict: "provider" });
    return json({ error: message }, 500);
  }
});
