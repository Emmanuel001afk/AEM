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
// Only release assets explicitly labelled for Windows are treated as manual archives.
// Workflow ZIPs and arbitrary repository ZIPs may be incomplete distributions.
const releaseArtifactKind = (name: string): string | null =>
  /(?:^|[-_. ])(?:windows|win64|win32)(?:[-_. ]|$)/i.test(name) && /\.zip$/i.test(name) ? "zip" : artifactKind(name);
const releasePlatform = (kind: string) => kind === "zip" ? "windows" : platform(kind);
// OEA's games belong inside its launcher, not as installable store packages.
const isCatalogApk = (repo: string, packageName?: string) =>
  repo.toLowerCase() !== "emmanuel001afk/oea" || packageName === "com.oea.launcher";
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
  const build = /(^|[-_. ])debug([-. _]|$)/.test(lower) ? "debug" : "release";
  let abi = "default";
  if (/(^|[-_.])(x86_64|amd64)([-. _]|$)/.test(lower)) abi = "x86_64";
  else if (/(^|[-_.])(x86)([-. _]|$)/.test(lower)) abi = "x86";
  else if (/(^|[-_.])(arm64|aarch64|arm64-v8a)([-. _]|$)/.test(lower)) abi = "arm64";
  else if (/(^|[-_.])(armeabi|armv7)([-. _]|$)/.test(lower)) abi = "armv7";
  // A newer debug build must never evict the last usable release build.
  return `${pkg}:${abi}:${build}`;
};
const sourceTimestampForOrdering = (value: unknown): number => {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) && parsed <= Date.now() + 5 * 60 * 1000 ? parsed : 0;
};
const releaseActivity = (release: any) => Math.max(
  sourceTimestampForOrdering(release.published_at || release.created_at),
  ...(release.assets || []).map((asset: any) => sourceTimestampForOrdering(asset.updated_at)),
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

// AEM's Windows CI publishes source-derived installers in AEM Releases.
// These reserved tags are associated with their source app, never AEM Store.
const AEM_EXE_SOURCE_REPOS: Record<string,string> = {
  "emmanuel001afk/ema": "ema", "emmanuel001afk/oea": "oea",
};
function aemExeReleaseMatches(repo: string, release: any): boolean {
  const slug=AEM_EXE_SOURCE_REPOS[repo.toLowerCase()];
  return !!slug && !release?.draft && !release?.prerelease && new RegExp(`^aem-exe-${slug}-[a-f0-9]{40}-[a-f0-9]{12}$`).test(String(release?.tag_name||""));
}
function isAemExeRelease(release: any): boolean {
  return /^aem-exe-(ema|oea)-[a-f0-9]{40}-[a-f0-9]{12}$/.test(String(release?.tag_name||""));
}

// Bound API work while inspecting more than the first page. If the bound is
// reached, surface that the scan may have missed an older release.
async function githubReleasePages(repo: string, headers: HeadersInit): Promise<{items: any[]; truncated: boolean}> {
  const items: any[] = [];
  const perPage = 100, maxPages = 5;
  for (let page = 1; page <= maxPages; page++) {
    const result = await gh(`${GH}/repos/${repo}/releases?per_page=${perPage}&page=${page}`, headers);
    if (!Array.isArray(result)) throw new Error("GitHub releases response is not an array");
    items.push(...result);
    if (result.length < perPage) return {items, truncated: false};
  }
  return {items, truncated: true};
}

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

// Obtain a short-lived object URL from GitHub; the credential is used only
// on the GitHub API request, never on the redirected object request.
async function privateReleaseAssetLocation(repo: string, assetId: unknown, headers: HeadersInit): Promise<string> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || !/^[1-9][0-9]*$/.test(String(assetId))) throw new Error("Invalid release asset");
  const response=await fetch(`${GH}/repos/${repo}/releases/assets/${assetId}`,{redirect:"manual",headers:{...headers as Record<string,string>,"Accept":"application/octet-stream"}});
  const location=response.headers.get("location");
  if (![301,302,303,307,308].includes(response.status) || !location) { await response.body?.cancel().catch(()=>{}); throw new Error("Unable to obtain release asset location"); }
  const url=new URL(location);
  if (url.protocol!=="https:" || url.username || url.password) throw new Error("Invalid release asset location");
  return url.toString();
}

// Read only bounded ZIP structures from an anonymously accessible release asset.
// The GitHub SHA-256 is pinned in the catalog and checked by the installer;
// these ranges are metadata inspection, not cryptographic signature validation.
async function inspectPublicApkRanges(url: string, size: number) {
  if (!Number.isSafeInteger(size) || size < 22 || size > 0xffffffff) throw new Error("Unsupported APK size or ZIP64 archive");
  const readRange = async (start: number, end: number): Promise<Uint8Array> => {
    if (start < 0 || end < start || end >= size || end - start + 1 > MAX_MANIFEST_BYTES) throw new Error("Invalid APK range");
    const r = await fetch(url, {headers:{Range:`bytes=${start}-${end}`, "Accept-Encoding":"identity"}});
    const expected = end - start + 1;
    const contentRange = `bytes ${start}-${end}/${size}`;
    if (r.status !== 206 || r.headers.get("content-range") !== contentRange || !r.body) {
      await r.body?.cancel().catch(()=>{});
      throw new Error("Source does not support verified byte ranges");
    }
    const out = new Uint8Array(expected);
    let offset = 0;
    const reader = r.body.getReader();
    try {
      while (true) {
        const {done,value} = await reader.read();
        if (done) break;
        if (!value || offset + value.length > expected) { await reader.cancel().catch(()=>{}); throw new Error("Invalid APK range length"); }
        out.set(value,offset); offset += value.length;
      }
    } finally { reader.releaseLock(); }
    if (offset !== expected) throw new Error("Truncated APK range");
    return out;
  };
  const start = Math.max(0,size-65557);
  const tail = await readRange(start,size-1);
  const tv = new DataView(tail.buffer,tail.byteOffset,tail.byteLength);
  let eocd = -1;
  for (let p=tail.length-22;p>=0;p--) {
    if (tv.getUint32(p,true)===0x06054b50 && p+22+tv.getUint16(p+20,true)===tail.length) { eocd=p; break; }
  }
  if (eocd<0 || tv.getUint16(eocd+4,true)!==0 || tv.getUint16(eocd+6,true)!==0) throw new Error("Invalid APK ZIP directory");
  const count=tv.getUint16(eocd+10,true), length=tv.getUint32(eocd+12,true), central=tv.getUint32(eocd+16,true);
  if (count===0xffff || length===0xffffffff || central===0xffffffff || length===0 || length>4*1024*1024 || central+length>start+eocd) throw new Error("Unsupported APK ZIP directory");
  const directory=await readRange(central,central+length-1);
  const dv=new DataView(directory.buffer,directory.byteOffset,directory.byteLength);
  let cursor=0, manifest: {method:number; compressed:number; uncompressed:number; offset:number}|undefined, hasV1=false;
  for (let i=0;i<count;i++) {
    if (cursor+46>length || dv.getUint32(cursor,true)!==0x02014b50) throw new Error("Malformed APK ZIP directory");
    const nl=dv.getUint16(cursor+28,true), xl=dv.getUint16(cursor+30,true), cl=dv.getUint16(cursor+32,true);
    if (cursor+46+nl+xl+cl>length) throw new Error("Truncated APK directory entry");
    const name=new TextDecoder().decode(directory.subarray(cursor+46,cursor+46+nl));
    if (/^META-INF\/[^/]+\.(RSA|DSA|EC)$/i.test(name)) hasV1=true;
    if (name==="AndroidManifest.xml") {
      if (manifest) throw new Error("Duplicate APK manifest");
      manifest={method:dv.getUint16(cursor+10,true),compressed:dv.getUint32(cursor+20,true),uncompressed:dv.getUint32(cursor+24,true),offset:dv.getUint32(cursor+42,true)};
    }
    cursor+=46+nl+xl+cl;
  }
  if (cursor!==length || !manifest || manifest.compressed>MAX_MANIFEST_BYTES || manifest.uncompressed>MAX_MANIFEST_BYTES || manifest.offset+30>central) throw new Error("APK manifest unavailable");
  let signed=hasV1;
  if (!signed && central>=16) signed=new TextDecoder().decode(await readRange(central-16,central-1))==="APK Sig Block 42";
  if (!signed) throw new Error("APK signing data unavailable");
  const local=await readRange(manifest.offset,manifest.offset+29);
  const lv=new DataView(local.buffer,local.byteOffset,local.byteLength);
  if (lv.getUint32(0,true)!==0x04034b50 || lv.getUint16(8,true)!==manifest.method) throw new Error("Malformed APK manifest header");
  const dataStart=manifest.offset+30+lv.getUint16(26,true)+lv.getUint16(28,true);
  if (manifest.compressed<1 || dataStart+manifest.compressed>central) throw new Error("Invalid APK manifest range");
  const raw=await readRange(dataStart,dataStart+manifest.compressed-1);
  const xml=manifest.method===0?raw:manifest.method===8?await inflateBounded(raw,MAX_MANIFEST_BYTES):null;
  if (!xml || xml.length!==manifest.uncompressed) throw new Error("Invalid APK manifest data");
  return parseApkManifest(xml);
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

// A PyInstaller onedir executable cannot run without its adjacent _internal
// directory. Do not publish it as a standalone EXE (including nested workers).
const requiresAdjacentFiles = (path: string, entries: string[]): boolean => {
  const normalized = path.replace(/\\/g, "/");
  const dir = normalized.includes("/") ? normalized.slice(0, normalized.lastIndexOf("/") + 1) : "";
  return entries.some((entry) => entry.replace(/\\/g, "/").toLowerCase().startsWith((dir + "_internal/").toLowerCase()));
};

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
    const entries: string[] = [];
    let scan = cursor;
    for (let i = 0; i < count && scan + 46 <= data.length; i++) {
      if (u32(scan) !== 0x02014b50) return [];
      const nameLength = u16(scan + 28), extraLength = u16(scan + 30), commentLength = u16(scan + 32);
      if (scan + 46 + nameLength + extraLength + commentLength > data.length) return [];
      entries.push(new TextDecoder().decode(data.slice(scan + 46, scan + 46 + nameLength)));
      scan += 46 + nameLength + extraLength + commentLength;
    }
    if (entries.length !== count) return [];
    for (let i = 0; i < count && cursor + 46 <= data.length; i++) {
      if (u32(cursor) !== 0x02014b50) break;
      const method = u16(cursor + 10), compressed = u32(cursor + 20), size = u32(cursor + 24);
      const nameLength = u16(cursor + 28), extraLength = u16(cursor + 30), commentLength = u16(cursor + 32), local = u32(cursor + 42);
      if (cursor + 46 + nameLength + extraLength + commentLength > data.length) break;
      const fullName = new TextDecoder().decode(data.slice(cursor + 46, cursor + 46 + nameLength));
      cursor += 46 + nameLength + extraLength + commentLength;
      const kind = artifactKind(fullName);
      const limit = (kind === "exe" ? 450 : 100) * 1024 * 1024;
      if (!kind || size > limit || compressed > limit || (kind === "exe" && requiresAdjacentFiles(fullName, entries))) continue;
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
      sourceTimestampForOrdering(artifact.source_updated_at),
      sourceTimestampForOrdering(release.published_at || release.created_at),
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
      sourceTimestampForOrdering(artifact.source_updated_at),
      sourceTimestampForOrdering(release.published_at || release.created_at),
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
    const { data: remainingArts, error: remainingError } = await sb.from("artifacts").select("release_id").in("release_id", relRes.data.map((r: any) => r.id));
    if (remainingError) throw new Error(`APK retention could not check remaining artifacts: ${remainingError.message}`);
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
      const repoWarnings: string[] = [];
      let repoFailed = false;
      try {
        const tree = await gh(`${GH}/repos/${repo.full_name}/git/trees/${repo.default_branch || "main"}?recursive=1`, headers).catch((e) => { repoWarnings.push(`Could not inspect repository files: ${String(e)}`); return { tree: [] }; });
        if (tree.truncated) repoWarnings.push("Repository file listing was truncated");
        const allTreeBinaries = (tree.tree || []).filter((x: any) => x.type === "blob" && artifactKind(String(x.path)) && !/(^|\/)(tests?|fixtures?|samples?)\//i.test(String(x.path)));
        if (allTreeBinaries.some((x: any) => Number(x.size || 0) > 50 * 1024 * 1024)) repoWarnings.push("Some repository binary files exceed the 50 MiB sync limit");
        const treeFiles = allTreeBinaries.filter((x: any) => Number(x.size || 0) <= 50 * 1024 * 1024);
        const sourceFiles: any[] = [];
        for (const plat of ["android", "windows"]) {
          const candidates = treeFiles.filter((x: any) => platform(artifactKind(String(x.path)) || "") === plat);
          candidates.sort((a: any, b: any) => Number(/(^|[-_. ])debug([-. _]|$)/i.test(String(a.path))) - Number(/(^|[-_. ])debug([-. _]|$)/i.test(String(b.path))) || String(a.path).localeCompare(String(b.path)));
          const file = candidates[0];
          if (file) sourceFiles.push(file);
        }
        const releasePage = await githubReleasePages(String(repo.full_name), headers).catch((e) => { repoWarnings.push(`Could not inspect releases: ${String(e)}`); return {items: [], truncated: false}; });
        const releaseRows = releasePage.items;
        if (releasePage.truncated) repoWarnings.push("Release scan reached its 500-release limit");
        const sortedReleases = Array.isArray(releaseRows) ? releaseRows
          .filter((r: any) => !r.draft && !(String(repo.full_name).toLowerCase()==="emmanuel001afk/aem" && isAemExeRelease(r)) && (r.assets || []).some((a: any) => releaseArtifactKind(a.name)))
          .sort((a: any, b: any) => releaseActivity(b) - releaseActivity(a)) : [];
        const pickedReleases = new Map<number, any>();
        for (const r of sortedReleases.slice(0, 4)) pickedReleases.set(Number(r.id), r);
        for (const plat of ["android", "windows"]) {
          const match = sortedReleases.find((r: any) => (r.assets || []).some((a: any) => {
            const k = releaseArtifactKind(String(a.name));
            return k !== null && releasePlatform(k) === plat;
          }));
          if (match) pickedReleases.set(Number(match.id), match);
          // Keep the newest non-debug release as well as the newest artifact.
          const releaseBuild = sortedReleases.find((r: any) => (r.assets || []).some((a: any) => {
            const k = releaseArtifactKind(String(a.name));
            return k !== null && releasePlatform(k) === plat && !/(^|[-_. ])debug([-. _]|$)/i.test(String(a.name));
          }));
          if (releaseBuild) pickedReleases.set(Number(releaseBuild.id), releaseBuild);
        }
        const releases = [...pickedReleases.values()].sort((a: any, b: any) => releaseActivity(b) - releaseActivity(a));
        const runs = await gh(`${GH}/repos/${repo.full_name}/actions/runs?status=success&branch=${encodeURIComponent(repo.default_branch || "main")}&per_page=50`, headers).catch((e) => { repoWarnings.push(`Could not inspect workflow runs: ${String(e)}`); return { workflow_runs: [] }; });
        const actionRuns = (runs.workflow_runs || []).filter((run: any) =>
          run.head_branch === (repo.default_branch || "main")
        ).slice(0, 10);
        const platforms = new Set<string>(sourceFiles.map((f: any) => platform(artifactKind(String(f.path)) || "")));
        for (const release of releases) for (const asset of release.assets || []) {
          const kind = releaseArtifactKind(String(asset.name)); if (kind) platforms.add(releasePlatform(kind));
        }
        const appResult = await sb.from("applications").select("id,project,name,package_identity,platforms,description_source,icon_source")
          .eq("provider", "github").eq("project", repo.full_name).maybeSingle();
        if (appResult.error) throw appResult.error;
        let app = appResult.data;
        const apkBuckets = app?.id ? await loadApkRetentionBuckets(sb, Number(app.id)) : new Map<string, ApkRetentionEntry[]>();
        const actionCandidates: Array<{ run: any; item: any; binaries: any[] }> = [];
        const actionWindowsArchives: Array<{run:any;item:any;digest:string}> = [];
        let inspectedActionArtifacts = 0, downloadedArchiveBytes = 0, discoveredBinaryBytes = 0;
        for (const run of actionRuns) {
          const publishedRun = app && await sb.from("releases").select("id").eq("application_id", app.id).eq("source_release_id", `github-actions-${run.id}`).maybeSingle();
          const items = await gh(`${GH}/repos/${repo.full_name}/actions/runs/${run.id}/artifacts?per_page=100&direction=desc`, headers).catch((e) => { repoWarnings.push(`Could not inspect workflow artifacts: ${String(e)}`); return { artifacts: [] }; });
          for (const item of items.artifacts || []) {
            if (publishedRun?.data && String(item.name || "") === "aem-store-release-apk") continue;
            const archiveSize = Number(item.size_in_bytes || 0);
            if (item.expired || archiveSize <= 0) continue;
            // Preserve the complete Windows workflow archive, not isolated EXEs
            // from an onedir package. Only successful default-branch runs qualify.
            const actionDigest=String(item.digest||"").replace(/^sha256:/i,"").toLowerCase();
            const expiry=Date.parse(String(item.expires_at||""));
            if (actionWindowsArchives.length<5 && /(?:^|[-_. ])(?:windows|win64|win32)(?:[-_. ]|$)/i.test(String(item.name||"")) && /^[a-f0-9]{64}$/.test(actionDigest) && Number.isFinite(expiry) && expiry>Date.now()) {
              actionWindowsArchives.push({run,item,digest:actionDigest});
              platforms.add("windows");
              continue;
            }
            if (inspectedActionArtifacts >= MAX_WORKFLOW_ARTIFACTS_PER_REPO || downloadedArchiveBytes >= MAX_WORKFLOW_ARCHIVE_BYTES_PER_REPO || discoveredBinaryBytes >= MAX_DISCOVERED_BINARY_BYTES_PER_REPO) continue;
            if (archiveSize > 35 * 1024 * 1024 || downloadedArchiveBytes + archiveSize > MAX_WORKFLOW_ARCHIVE_BYTES_PER_REPO) {
              if (/apk|android|exe|windows|release/i.test(String(item.name || ""))) repoWarnings.push(`Skipped workflow artifact ${String(item.name).slice(0,100)}: archive exceeds sync limits`);
              continue;
            }
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
            if (!response.ok) { repoWarnings.push(`Could not download workflow artifact ${String(item.name).slice(0,100)}: HTTP ${response.status}`); continue; }
            if (Number(response.headers.get("content-length") || 0) > 40 * 1024 * 1024) { repoWarnings.push(`Skipped workflow artifact ${String(item.name).slice(0,100)}: archive exceeds sync limits`); continue; }
            const archive = new Uint8Array(await response.arrayBuffer());
            downloadedArchiveBytes += archive.byteLength;
            const binaries = await archiveBinaries(archive);
            const supported: any[] = [];
            const itemUpdatedMs = sourceTimestampForOrdering(item.updated_at || item.created_at || run.updated_at || run.created_at);
            let prunedAny = false;
            for (const binary of binaries) {
              const kind = artifactKind(binary.name);
              if (!kind || binary.bytes.byteLength > 50 * 1024 * 1024 || discoveredBinaryBytes + binary.bytes.byteLength > MAX_DISCOVERED_BINARY_BYTES_PER_REPO) continue;
              if (kind === "apk") {
                if (!isCatalogApk(String(repo.full_name), binary.packageName)) continue;
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
          const detected = platform(kind);
          if (!(app!.platforms || []).includes(detected)) {
            app!.platforms = [...(app!.platforms || []), detected];
            await sb.from("applications").update({ platforms: app!.platforms, updated_at: new Date().toISOString() }).eq("id", app!.id);
          }
        };
        const ensureRelease = async (sourceId: string, name: string, channel: string, title: string, publishedAt: string | null, clearUnknownDate = false) => {
          const found = await sb.from("releases").select("id,version_name,version_code,published_at").eq("application_id", app!.id).eq("source_release_id", sourceId).maybeSingle();
          if (found.error) throw found.error;
          if (found.data) {
            // Repair stale catalog values from the authoritative source date. Asset
            // updated_at is intentionally never copied into a release publication date.
            const currentPublishedMs = Date.parse(String(found.data.published_at || "")) || 0;
            const sourcePublishedMs = Date.parse(String(publishedAt || "")) || 0;
            if (publishedAt && sourcePublishedMs && currentPublishedMs !== sourcePublishedMs) {
              const repaired = await sb.from("releases").update({ published_at: publishedAt }).eq("id", found.data.id);
              if (repaired.error) throw repaired.error;
              found.data.published_at = publishedAt;
            } else if (!publishedAt && clearUnknownDate && found.data.published_at) {
              const cleared = await sb.from("releases").update({ published_at: null }).eq("id", found.data.id);
              if (cleared.error) throw cleared.error;
              found.data.published_at = null;
            }
            return found.data;
          }
          const created = await sb.from("releases").insert({
            application_id: app!.id, source_release_id: sourceId, version_name: name,
            channel: releaseChannel(channel), status: "published", title, published_at: publishedAt,
          }).select("id,version_name,version_code,published_at").single();
          if (created.error) throw created.error; totals.releases++; return created.data;
        };

        // Read only AEM-owned release assets with a project-specific reserved
        // tag. The source repo remains the catalog identity and no EXE is copied
        // to the Supabase bucket. SHA-256 comes from GitHub release metadata.
        if (AEM_EXE_SOURCE_REPOS[String(repo.full_name).toLowerCase()]) {
          try {
            const externalReleases=await gh(`${GH}/repos/Emmanuel001afk/AEM/releases?per_page=100`,headers);
            if (!Array.isArray(externalReleases)) throw new Error("Invalid AEM releases response");
            const selected=externalReleases.filter((r:any)=>aemExeReleaseMatches(String(repo.full_name),r)).sort((a:any,b:any)=>releaseActivity(b)-releaseActivity(a)).slice(0,2);
            for (const ext of selected) {
              const candidates=(ext.assets||[]).filter((a:any)=>/\.exe$/i.test(String(a.name||"")) && /^[a-f0-9]{64}$/i.test(String(a.digest||"").replace(/^sha256:/i,"")) && /^https:\/\/github\.com\/Emmanuel001afk\/AEM\/releases\/download\//i.test(String(a.browser_download_url||"")));
              if (!candidates.length) { repoWarnings.push(`No hashed EXEs in ${String(ext.tag_name).slice(0,100)}`); continue; }
              const version=extractExeVersion(undefined,String(candidates[0].name),String(ext.name||"")) || String(ext.tag_name);
              const row=await ensureRelease(`github-release-${ext.id}`,version,"stable",String(ext.name||"Windows build"),ext.published_at||null);
              for (const asset of candidates) {
                const hash=String(asset.digest).replace(/^sha256:/i,"").toLowerCase();
                const payload={release_id:row.id,platform:"windows",kind:"exe",filename:String(asset.name),download_url:String(asset.browser_download_url),size_bytes:Number(asset.size)||null,sha256:hash,source_sha256:hash,source_updated_at:asset.updated_at||ext.published_at||null,artifact_version_name:extractExeVersion(undefined,String(asset.name),version),package_identity:sanitizeWindowsIdentity(app!.package_identity,repo.full_name),signing_status:"ready"};
                const prior=await sb.from("artifacts").select("id").eq("release_id",row.id).eq("filename",payload.filename).maybeSingle();
                if (prior.error) throw prior.error;
                const saved=prior.data?await sb.from("artifacts").update(payload).eq("id",prior.data.id):await sb.from("artifacts").insert(payload);
                if (saved.error) throw saved.error;
                totals.artifacts++;
              }
              if (!(app!.platforms||[]).includes("windows")) {
                app!.platforms=[...(app!.platforms||[]),"windows"];
                const updated=await sb.from("applications").update({platforms:app!.platforms,updated_at:new Date().toISOString()}).eq("id",app!.id);
                if (updated.error) throw updated.error;
              }
            }
          } catch (error) { repoWarnings.push(`Could not inspect AEM Windows releases: ${String(error).slice(0,180)}`); }
        }
        for (const release of releases) {
          const name = String(release.tag_name || release.name || "unknown"), id = `github-release-${release.id}`;
          const existingRelease = await sb.from("releases").select("id").eq("application_id", app.id).eq("source_release_id", id).maybeSingle();
          if (existingRelease.error) throw existingRelease.error;
          const validAssets: Array<{ asset: any; kind: string; bytes?: Uint8Array; metadata: any; digest?: string; external?: boolean; sourceUpdatedAt?: string | null; privateAsset?: boolean }> = [];
          const releaseBinaries = (release.assets || []).filter((x: any) => releaseArtifactKind(String(x.name)));
          for (const asset of releaseBinaries) {
            const kind = releaseArtifactKind(String(asset.name))!;
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
              if (unchanged && !(repo.private && (kind === "apk" || kind === "exe") && size > 50*1024*1024 && cached.data?.signing_status !== "ready")) {
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
            // Private EXEs can also be served without copying them to Storage.
            // GitHub's immutable asset ID and digest are stored; only the gateway
            // obtains a short-lived URL, and the client verifies the digest.
            if (kind === "exe" && repo.private && size > 50*1024*1024) {
              if (!hasSourceDigest || !/^[1-9][0-9]*$/.test(String(asset.id))) {
                repoWarnings.push(`Skipped ${String(asset.name).slice(0,100)}: private EXE requires an asset ID and SHA-256`); continue;
              }
              validAssets.push({asset,kind,metadata:{versionName:extractExeVersion(undefined,String(asset.name),name)},digest,privateAsset:true,sourceUpdatedAt});
              continue;
            }
            // Private large release assets use the same bounded inspection but
            // publish only an AEM gateway URL, never a credential or signed URL.
            if (kind === "apk" && repo.private && size > 50*1024*1024) {
              if (!hasSourceDigest) { repoWarnings.push(`Skipped ${String(asset.name).slice(0,100)}: SHA-256 required for private APK`); continue; }
              try {
                const location=await privateReleaseAssetLocation(String(repo.full_name),asset.id,headers);
                const metadata=await inspectPublicApkRanges(location,size);
                const vc=Number(metadata.versionCode||0);
                if (!metadata.packageName || !isCatalogApk(String(repo.full_name),metadata.packageName) || !Number.isInteger(vc) || vc<=0) throw new Error("Invalid package identity or version");
                const ch=releaseChannel(name), ts=sourceTimestampForOrdering(sourceUpdatedAt);
                if (!wouldKeepApk(apkBuckets,ch,String(asset.name),String(metadata.packageName),vc,ts,id)) continue;
                recordKeptApk(apkBuckets,ch,String(asset.name),String(metadata.packageName),vc,ts,id);
                validAssets.push({asset,kind,metadata,digest,external:true,privateAsset:true,sourceUpdatedAt});
              } catch (error) { repoWarnings.push(`Skipped ${String(asset.name).slice(0,100)}: private APK metadata unavailable`); }
              continue;
            }
            // Larger public APKs are inspected with bounded byte ranges. Never
            // send a GitHub credential to an asset URL; private assets cannot use this path.
            if (kind === "apk" && size > MAX_PUBLIC_RELEASE_APK_BYTES) {
              if (repo.private || !hasSourceDigest || !/^https:\/\/github\.com\//i.test(String(asset.browser_download_url || ""))) {
                repoWarnings.push(`Skipped ${String(asset.name).slice(0,100)}: public release URL and SHA-256 required for large APK`); continue;
              }
              try {
                const metadata=await inspectPublicApkRanges(String(asset.browser_download_url),size);
                const vc=Number(metadata.versionCode || 0);
                if (!metadata.packageName || !isCatalogApk(String(repo.full_name),metadata.packageName) || !Number.isInteger(vc) || vc<=0) throw new Error("Invalid package identity or version");
                const ch=releaseChannel(name), ts=sourceTimestampForOrdering(sourceUpdatedAt);
                if (!wouldKeepApk(apkBuckets,ch,String(asset.name),String(metadata.packageName),vc,ts,id)) continue;
                recordKeptApk(apkBuckets,ch,String(asset.name),String(metadata.packageName),vc,ts,id);
                validAssets.push({asset,kind,metadata,digest,external:true,sourceUpdatedAt});
              } catch (error) { repoWarnings.push(`Skipped ${String(asset.name).slice(0,100)}: ${String(error).slice(0,200)}`); }
              continue;
            }
            if (size > 300 * 1024 * 1024) { repoWarnings.push(`Skipped ${String(asset.name).slice(0,100)}: release asset exceeds sync limits`); continue; }
            if (kind === "zip") {
              // A public release ZIP is a manual download, never an auto-run EXE.
              if (!repo.private && hasSourceDigest && /^https:\/\/github\.com\//i.test(String(asset.browser_download_url || ""))) {
                validAssets.push({ asset, kind, metadata: {}, digest, sourceUpdatedAt });
              } else repoWarnings.push(`Skipped Windows archive ${String(asset.name).slice(0,100)}: public URL and SHA-256 required`);
              continue;
            }
            if (kind === "exe" && !repo.private && size > 50 * 1024 * 1024 && /^[a-f0-9]{64}$/.test(digest)) {
              validAssets.push({ asset, kind, metadata: { versionName: extractExeVersion(undefined, String(asset.name), name) }, digest, sourceUpdatedAt });
              continue;
            }
            const pruneKey = `${id}::${String(asset.name)}`;
            const assetStamp = hasSourceDigest ? digest : String(sourceUpdatedAt || "");
            if (kind === "apk" && assetStamp && prunedCache[pruneKey] === assetStamp) continue;
            const oversizedPublicApk = kind === "apk" && !repo.private && size > 50 * 1024 * 1024 && size <= MAX_PUBLIC_RELEASE_APK_BYTES;
            if (size > 50 * 1024 * 1024 && !oversizedPublicApk) { repoWarnings.push(`Skipped ${String(asset.name).slice(0,100)}: release asset exceeds sync limits`); continue; }
            const response = await fetch(asset.browser_download_url, { headers }); if (!response.ok) { repoWarnings.push(`Could not download ${String(asset.name).slice(0,100)}: HTTP ${response.status}`); continue; }
            const bytes = new Uint8Array(await response.arrayBuffer());
            const metadata = kind === "apk" ? await apkMetadata(bytes) : { versionName: extractExeVersion(bytes, String(asset.name), name) };
            if (kind === "apk" && (!metadata.packageName || !isCatalogApk(String(repo.full_name), metadata.packageName) || (oversizedPublicApk && !apkHasSignature(bytes)))) {
              if (oversizedPublicApk) repoWarnings.push(`Skipped ${String(asset.name).slice(0,100)}: APK metadata or signing data unavailable`);
              continue;
            }
            // A public source APK must match the release digest before its URL
            // is published. Android still verifies the APK signature at install.
            let externalDigest = digest;
            if (oversizedPublicApk) {
              externalDigest = await sha256(bytes);
              if (hasSourceDigest && digest !== externalDigest) { repoWarnings.push(`Skipped ${String(asset.name).slice(0,100)}: SHA-256 mismatch`); continue; }
            }
            if (kind === "apk") {
              const ch = releaseChannel(name);
              const vc = Number(metadata.versionCode || 0);
              const ts = sourceTimestampForOrdering(sourceUpdatedAt || release.published_at || release.created_at);
              if (!wouldKeepApk(apkBuckets, ch, String(asset.name), String(metadata.packageName || ""), vc, ts, id)) {
                if (assetStamp) prunedCache[pruneKey] = assetStamp;
                continue;
              }
              delete prunedCache[pruneKey];
              recordKeptApk(apkBuckets, ch, String(asset.name), String(metadata.packageName || ""), vc, ts, id);
            }
            if (oversizedPublicApk) {
              validAssets.push({ asset, kind, metadata, digest: externalDigest, external: true, sourceUpdatedAt });
            } else {
              validAssets.push({ asset, kind, bytes, metadata, digest: hasSourceDigest ? digest : undefined, sourceUpdatedAt });
            }
          }
          if (!validAssets.length) continue;
          const row = await ensureRelease(id, name, name, release.name || name, release.published_at || null);
          for (const item of validAssets) {
            const { asset, kind, bytes, metadata, digest, sourceUpdatedAt } = item;
            if (digest && ((kind === "zip" && !repo.private) || (kind === "exe" && Number(asset.size || 0) > 50 * 1024 * 1024))) {
              const payload = {
                release_id: row.id, platform: "windows", kind, filename: String(asset.name), download_url: asset.browser_download_url,
                size_bytes: Number(asset.size), sha256: digest, source_sha256: digest, source_updated_at: sourceUpdatedAt,
                artifact_version_name: metadata.versionName || extractExeVersion(undefined, String(asset.name), name),
                package_identity: sanitizeWindowsIdentity(app.package_identity, repo.full_name), signing_status: "ready",
              };
              const prior = await sb.from("artifacts").select("id").eq("release_id", row.id).eq("filename", String(asset.name)).maybeSingle();
              if (prior.error) throw prior.error;
              if (item.privateAsset) { payload.download_url=`${Deno.env.get("SUPABASE_URL")}/functions/v1/aem-github-download`; payload.signing_status="failed"; }
              const result = prior.data ? await sb.from("artifacts").update(payload).eq("id", prior.data.id).select("id").single() : await sb.from("artifacts").insert(payload).select("id").single();
              if (result.error) throw result.error;
              if (item.privateAsset) {
                const artifactId=result.data.id;
                const linked=await sb.from("github_download_sources").upsert({artifact_id:artifactId,repo:repo.full_name,source_kind:"release_asset",github_id:asset.id,expires_at:null});
                if (linked.error) throw linked.error;
                const ready=await sb.from("artifacts").update({download_url:`${Deno.env.get("SUPABASE_URL")}/functions/v1/aem-github-download?id=${artifactId}`,signing_status:"ready",signing_error:null}).eq("id",artifactId);
                if (ready.error) throw ready.error;
              }
              totals.artifacts++;
            } else if (kind === "apk" && item.external) {
              const payload: any = {
                release_id: row.id, platform: "android", kind, filename: String(asset.name), download_url: asset.browser_download_url,
                size_bytes: Number(asset.size), sha256: digest || null, source_sha256: digest || null, source_updated_at: sourceUpdatedAt,
                artifact_version_name: metadata.versionName || null,
                package_identity: metadata.packageName || app!.package_identity || null,
                version_code: metadata.versionCode ?? null, signing_status: "ready", signing_authority: "source", signing_certificate_sha256: null, signing_error: null,
              };
              const prior = await sb.from("artifacts").select("id").eq("release_id", row.id).eq("filename", String(asset.name)).maybeSingle();
              if (prior.error) throw prior.error;
              if (item.privateAsset) { payload.download_url=`${Deno.env.get("SUPABASE_URL")}/functions/v1/aem-github-download`; payload.signing_status="failed"; payload.signing_error="Source link is being prepared"; }
              const result = prior.data ? await sb.from("artifacts").update(payload).eq("id", prior.data.id).select("id").single() : await sb.from("artifacts").insert(payload).select("id").single();
              if (result.error) throw result.error;
              if (item.privateAsset) {
                const artifactId=result.data.id;
                const linked=await sb.from("github_download_sources").upsert({artifact_id:artifactId,repo:repo.full_name,source_kind:"release_asset",github_id:asset.id,expires_at:null});
                if (linked.error) throw linked.error;
                const ready=await sb.from("artifacts").update({download_url:`${Deno.env.get("SUPABASE_URL")}/functions/v1/aem-github-download?id=${artifactId}`,signing_status:"ready",signing_error:null}).eq("id",artifactId);
                if (ready.error) throw ready.error;
              }
              totals.artifacts++;
              if (metadata.packageName && !app!.package_identity) {
                app!.package_identity = metadata.packageName;
                await sb.from("applications").update({ package_identity: metadata.packageName, updated_at: new Date().toISOString() }).eq("id", app!.id);
              }
              if (Number.isInteger(metadata.versionCode) && Number(metadata.versionCode) > Number(row.version_code || 0)) {
                row.version_code = Number(metadata.versionCode);
                await sb.from("releases").update({ version_code: Number(metadata.versionCode) }).eq("id", row.id);
              }
            } else if (bytes) {
              await save(row, String(asset.name), bytes, kind, `${repo.full_name}/${safeName(name)}/${safeName(String(asset.name))}`, metadata,
                { sha256: digest, updatedAt: sourceUpdatedAt, releaseName: name });
            }
          }
        }
        for (const file of sourceFiles) {
          const id = `github-file-${file.sha}`;
          const exists = await sb.from("releases").select("id,published_at").eq("application_id", app.id).eq("source_release_id", id).maybeSingle();
          if (exists.error) throw exists.error;
          if (exists.data) {
            // Repository tree binaries have no trustworthy publication timestamp;
            // older syncs used the sync time, so remove that misleading value.
            if (exists.data.published_at) {
              const cleared = await sb.from("releases").update({ published_at: null }).eq("id", exists.data.id);
              if (cleared.error) throw cleared.error;
            }
            continue;
          }
          const path = String(file.path), kind = artifactKind(path)!;
          const response = await fetch(`https://raw.githubusercontent.com/${repo.full_name}/${repo.default_branch || "main"}/${path.split("/").map(encodeURIComponent).join("/")}`, { headers });
          if (!response.ok) continue;
          const bytes = new Uint8Array(await response.arrayBuffer());
          const metadata = kind === "apk" ? await apkMetadata(bytes) : {};
          if (kind === "apk" && (!metadata.packageName || !isCatalogApk(String(repo.full_name), metadata.packageName))) continue;
          const created = await ensureRelease(id, "Repository binary", "development", path, null, true);
          await save(created, path.split("/").pop() || `application.${kind}`, bytes, kind,
            `${repo.full_name}/source/${file.sha}/${safeName(path.split("/").pop() || "application")}`, metadata);
        }
        for (const {run,item,digest} of actionWindowsArchives) {
          const sourceId=`github-actions-artifact-${item.id}`;
          const createdAt=item.created_at || run.updated_at || run.created_at;
          const row=await ensureRelease(sourceId,`workflow-${run.run_number||item.id}`,"development",String(item.name||"Windows workflow archive"),createdAt||null);
          const filename=safeName(String(item.name||"windows"))+".zip";
          const existing=await sb.from("artifacts").select("id").eq("release_id",row.id).eq("filename",filename).maybeSingle();
          if (existing.error) throw existing.error;
          const payload={release_id:row.id,platform:"windows",kind:"zip",filename,download_url:`${Deno.env.get("SUPABASE_URL")}/functions/v1/aem-github-download`,size_bytes:Number(item.size_in_bytes),sha256:digest,source_sha256:digest,source_updated_at:item.updated_at||createdAt,source_expires_at:item.expires_at,package_identity:sanitizeWindowsIdentity(app!.package_identity,repo.full_name),signing_status:"pending"};
          const saved=existing.data?await sb.from("artifacts").update(payload).eq("id",existing.data.id).select("id").single():await sb.from("artifacts").insert(payload).select("id").single();
          if (saved.error) throw saved.error;
          const artifactId=saved.data.id;
          const linked=await sb.from("github_download_sources").upsert({artifact_id:artifactId,repo:repo.full_name,source_kind:"actions_artifact",github_id:item.id,expires_at:item.expires_at});
          if (linked.error) throw linked.error;
          const ready=await sb.from("artifacts").update({download_url:`${Deno.env.get("SUPABASE_URL")}/functions/v1/aem-github-download?id=${artifactId}`,signing_status:"ready",signing_error:null}).eq("id",artifactId);
          if (ready.error) throw ready.error;
          totals.artifacts++;
        }
        for (const { run, item, binaries } of actionCandidates) {
          const id = `github-actions-artifact-${item.id}`;
          const runLabel = run.run_number || item.workflow_run?.run_number || item.id;
          const createdAt = item.created_at || run.updated_at || run.created_at;
          const row = await ensureRelease(id, `workflow-${runLabel}`, "development", String(item.name || "GitHub Actions artifact"), createdAt || null);
          for (const binary of binaries) {
            const kind = artifactKind(binary.name);
            if (kind) await save(row, binary.name, binary.bytes, kind,
              `${repo.full_name}/actions/${item.id}/${safeName(binary.name)}`, binary,
              { updatedAt: item.updated_at || item.created_at || run.updated_at || run.created_at });
          }
        }
        await retainCurrentAndPreviousApks(sb, Number(app.id));
      } catch (error) {
        repoFailed = true;
        totals.failures++;
        const issue = error as any;
        const detail = `${repo.full_name}: ${issue?.message || JSON.stringify(issue) || String(error)}`;
        failureDetails.push(detail.slice(0, 500));
        console.error("Repository discovery failed", detail);
      } finally {
        if (repoWarnings.length) {
          if (!repoFailed) totals.failures++;
          failureDetails.push(`${repo.full_name}: ${[...new Set(repoWarnings)].slice(0, 4).join("; ")}`.slice(0,500));
        }
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
      last_error: status === "running" && totals.failures ? JSON.stringify({count: totals.failures, details: failureDetails.slice(-7)}).slice(0,4000) : error, repositories_scanned: complete ? repositories.length : nextIndex,
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
