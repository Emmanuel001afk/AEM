import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import yauzl from "yauzl";

export function runCommand(file, args, options = {}) {
  const { timeoutMs = 60000, input, onLog, env, cwd, maxOutput = 2 * 1024 * 1024 } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, env, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "", settled = false, timedOut = false;
    const append = (current, chunk, name) => {
      const text = chunk.toString();
      onLog?.(text, name);
      return (current + text).slice(-maxOutput);
    };
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk, "stdout"); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk, "stderr"); });
    child.on("error", (error) => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } });
    child.on("close", (code) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); } });
    child.stdin.on("error", () => {});
    if (input) child.stdin.end(input); else child.stdin.end();
  });
}
export async function checkedCommand(file, args, options = {}) {
  const result = await runCommand(file, args, options);
  if (result.code !== 0 || result.timedOut) {
    const detail = `${result.stderr}\n${result.stdout}`.trim().slice(-3500);
    throw new Error(`${path.basename(file)} ${result.timedOut ? "timed out" : `failed (exit ${result.code})`}${detail ? `: ${detail}` : "."}`);
  }
  return result;
}
export async function sha256File(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
const DOWNLOAD_HOSTS = new Set(["dl.google.com", "github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"]);
export async function downloadFile(url, destination, { sha256, maxBytes = 2 * 1024 ** 3, onProgress, timeoutMs = 900000 } = {}) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const partial = `${destination}.partial`;
  await fs.rm(partial, { force: true });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response, current = new URL(url);
    for (let redirects = 0; redirects <= 5; redirects++) {
      if (current.protocol !== "https:" || !DOWNLOAD_HOSTS.has(current.hostname)) throw new Error(`Untrusted runtime download host: ${current.hostname}`);
      response = await fetch(current, { signal: controller.signal, redirect: "manual" });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location) throw new Error("Runtime download redirect has no destination.");
        current = new URL(location, current);
        await response.body?.cancel();
        continue;
      }
      break;
    }
    if (!response?.ok) throw new Error(`Runtime download failed: HTTP ${response?.status}. Check your internet connection and retry.`);
    const total = Number(response.headers.get("content-length") || 0);
    if (total > maxBytes) throw new Error("Runtime download exceeds the allowed size.");
    let bytes = 0, lastReport = 0;
    const counter = new Transform({ transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > maxBytes) return callback(new Error("Runtime download exceeds the allowed size."));
      if (Date.now() - lastReport > 200) { lastReport = Date.now(); onProgress?.({ bytes, total }); }
      callback(null, chunk);
    } });
    await pipeline(Readable.fromWeb(response.body), counter, createWriteStream(partial, { flags: "wx" }), { signal: controller.signal });
    if (sha256 && await sha256File(partial) !== sha256.toLowerCase()) throw new Error("Downloaded runtime archive failed SHA-256 verification. Nothing was installed.");
    await fs.rename(partial, destination);
    onProgress?.({ bytes, total: total || bytes });
    return { bytes, sha256: sha256 || await sha256File(destination) };
  } finally {
    clearTimeout(timer);
    await fs.rm(partial, { force: true }).catch(() => {});
  }
}

/** Extract only regular files/directories. Never follow archive links or absolute paths. */
export async function extractZip(archive, destination, { maxEntries = 30000, maxBytes = 8 * 1024 ** 3 } = {}) {
  await fs.mkdir(destination, { recursive: true });
  const root = path.resolve(destination);
  const zip = await new Promise((resolve, reject) => yauzl.open(archive, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, value) => error ? reject(error) : resolve(value)));
  let entries = 0, bytes = 0;
  try {
    await new Promise((resolve, reject) => {
      zip.on("entry", (entry) => {
        (async () => {
          if (++entries > maxEntries) throw new Error("Archive contains too many entries.");
          const name = entry.fileName;
          const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
          if (path.posix.isAbsolute(name) || /^[a-z]:/i.test(name) || name.includes("\\") || name.split("/").includes("..") || mode === 0xa000 || (mode !== 0 && mode !== 0x8000 && mode !== 0x4000)) {
            throw new Error(`Unsafe archive entry rejected: ${name.slice(0, 160)}`);
          }
          const target = path.resolve(root, name);
          if (!target.startsWith(root + path.sep)) throw new Error("Archive path escapes its destination.");
          if (/\/$/.test(name)) { await fs.mkdir(target, { recursive: true }); zip.readEntry(); return; }
          bytes += entry.uncompressedSize;
          if (bytes > maxBytes) throw new Error("Archive expands beyond the allowed size.");
          await fs.mkdir(path.dirname(target), { recursive: true });
          const stream = await new Promise((resolve, reject) => zip.openReadStream(entry, (error, value) => error ? reject(error) : resolve(value)));
          await pipeline(stream, createWriteStream(target, { flags: "wx" }));
          zip.readEntry();
        })().catch(reject);
      });
      zip.on("end", resolve);
      zip.on("error", reject);
      zip.readEntry();
    });
  } finally { zip.close(); }
  return { entries, bytes };
}
export async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2) + "\n", "utf8");
  await fs.rename(temporary, file);
}
export async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); } catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
}
export async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }
