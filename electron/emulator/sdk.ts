import fs from "fs";
import { downloadVerified } from "../download";
import { spawnSdk } from "./tool-process";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { existsSync } from "fs";
import { mkdir, rm, readdir } from "fs/promises";
import { pipeline } from "stream/promises";
import { Transform } from "stream";
import yauzl from "yauzl";
import { getSdkRoot, SDK_URLS, DEFAULT_SYSTEM_IMAGE, DEFAULT_API_LEVEL } from "../config";
import type { SdkStatus, SystemImageInfo } from "./types";

const execFileAsync = promisify(execFile);
const MAX_SDK_ARCHIVE_FILES = 50_000;
const MAX_SDK_ARCHIVE_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_SDK_FILE_BYTES = 2 * 1024 * 1024 * 1024;

function sdkRoot(): string {
  try { return getSdkRoot(); } catch { return path.join(process.cwd(), ".aem-sdk"); }
}

function platform(): "win" | "mac" | "linux" {
  if (process.platform === "win32") return "win";
  if (process.platform === "darwin") return "mac";
  return "linux";
}

export function getAdbPath(root?: string): string {
  const r = root || sdkRoot();
  const ext = process.platform === "win32" ? ".exe" : "";
  return path.join(r, "platform-tools", `adb${ext}`);
}

export function getEmulatorPath(root?: string): string {
  const r = root || sdkRoot();
  const ext = process.platform === "win32" ? ".exe" : "";
  return path.join(r, "emulator", `emulator${ext}`);
}

export function getAvdManagerPath(root?: string): string {
  const r = root || sdkRoot();
  const ext = process.platform === "win32" ? ".bat" : "";
  const c1 = path.join(r, "cmdline-tools", "latest", "bin", `avdmanager${ext}`);
  const c2 = path.join(r, "cmdline-tools", "bin", `avdmanager${ext}`);
  if (existsSync(c1)) return c1;
  return c2;
}

export function getSdkManagerPath(root?: string): string {
  const r = root || sdkRoot();
  const ext = process.platform === "win32" ? ".bat" : "";
  const c1 = path.join(r, "cmdline-tools", "latest", "bin", `sdkmanager${ext}`);
  const c2 = path.join(r, "cmdline-tools", "bin", `sdkmanager${ext}`);
  if (existsSync(c1)) return c1;
  return c2;
}

async function downloadFile(url: string, dest: string, onProgress?: (received: number, total: number) => void): Promise<void> {
  await downloadVerified(url, dest, undefined, 4 * 1024 ** 3, onProgress);
}

function safeDestPath(destRoot: string, entryName: string): string {
  const normalized = entryName.replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || /[\x00-\x1f]/.test(normalized) || /^[A-Za-z]:/.test(normalized)) {
    throw new Error(`Unsafe SDK archive path: ${entryName}`);
  }
  const parts = normalized.split("/").filter(Boolean);
  if (parts.some(p => p === "." || p === "..")) {
    throw new Error(`Unsafe SDK archive traversal: ${entryName}`);
  }
  const resolvedRoot = path.resolve(destRoot);
  const resolvedTarget = path.resolve(resolvedRoot, ...parts);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`SDK archive path escapes target directory: ${entryName}`);
  }
  return resolvedTarget;
}

export async function unzipSafe(zipPath: string, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true });
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) =>
    yauzl.open(zipPath, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (e, z) => (e ? reject(e) : resolve(z!)))
  );
  let count = 0;
  let totalBytes = 0;
  return new Promise((resolve, reject) => {
    let failed = false;
    const fail = (err: unknown) => {
      if (!failed) {
        failed = true;
        try { zip.close(); } catch {}
        reject(err);
      }
    };
    zip.on("error", fail);
    zip.on("end", () => { if (!failed) resolve(); });
    zip.on("entry", async (entry: yauzl.Entry) => {
      try {
        if (++count > MAX_SDK_ARCHIVE_FILES) throw new Error("SDK archive exceeds maximum entry limit");
        const mode = entry.externalFileAttributes >>> 16;
        if ((mode & 0xf000) === 0xa000) throw new Error(`Symlink not permitted in SDK archive: ${entry.fileName}`);
        if (entry.generalPurposeBitFlag & 1) throw new Error("Encrypted SDK archive unsupported");
        if (entry.uncompressedSize > MAX_SDK_FILE_BYTES || (totalBytes += entry.uncompressedSize) > MAX_SDK_ARCHIVE_BYTES) {
          throw new Error("SDK archive exceeds size limits");
        }
        const target = safeDestPath(destDir, entry.fileName);
        if (/\/$/.test(entry.fileName)) {
          await mkdir(target, { recursive: true });
        } else {
          await mkdir(path.dirname(target), { recursive: true });
          const stream = await new Promise<NodeJS.ReadableStream>((res, rej) =>
            zip.openReadStream(entry, (e, s) => (e ? rej(e) : res(s!)))
          );
          let written = 0;
          const bound = new Transform({
            transform(chunk, _enc, cb) {
              written += chunk.length;
              cb(written > entry.uncompressedSize ? new Error("SDK entry size overflow") : null, chunk);
            },
          });
          await pipeline(stream, bound, fs.createWriteStream(target, { flags: "w" }));
          if (written !== entry.uncompressedSize) throw new Error(`Truncated SDK entry: ${entry.fileName}`);
          if (process.platform !== "win32") {
            const posixMode = mode & 0o777;
            if ((posixMode & 0o111) !== 0 || /\/bin\//.test("/" + entry.fileName) || /(^|\/)(adb|fastboot|emulator|mksdcard|qemu-[^/]+)$/.test(entry.fileName)) {
              await fs.promises.chmod(target, posixMode || 0o755).catch(() => {});
            }
          }
        }
        if (!failed) zip.readEntry();
      } catch (err) {
        fail(err);
      }
    });
    zip.readEntry();
  });
}

export async function getSdkStatus(root?: string): Promise<SdkStatus> {
  const r = root || sdkRoot();
  const platToolsPath = getAdbPath(r);
  const emuPath = getEmulatorPath(r);
  const avdm = getAvdManagerPath(r);
  const sdkMgr = getSdkManagerPath(r);

  const platToolsInstalled = existsSync(platToolsPath);
  const emuInstalled = existsSync(emuPath);
  const cmdlineInstalled = existsSync(avdm) || existsSync(sdkMgr);

  const systemImagePath = path.join(r, "system-images", "android-34", "google_apis", "x86_64");
  const systemImageInstalled = existsSync(systemImagePath) && fs.readdirSync(systemImagePath).length > 0;

  let anySystemImage: string | null = null;
  try {
    const siRoot = path.join(r, "system-images");
    if (existsSync(siRoot)) {
      const levels = fs.readdirSync(siRoot);
      for (const lvl of levels) {
        const p = path.join(siRoot, lvl);
        if (!fs.statSync(p).isDirectory()) continue;
        const variants = fs.readdirSync(p);
        for (const v of variants) {
          const pp = path.join(p, v);
          if (!fs.statSync(pp).isDirectory()) continue;
          const abis = fs.readdirSync(pp);
          for (const abi of abis) {
            const candidate = path.join(pp, abi);
            if (fs.existsSync(path.join(candidate, "system.img")) || fs.existsSync(path.join(candidate, "kernel-ranchu"))) {
              anySystemImage = candidate;
              break;
            }
          }
        }
      }
    }
  } catch {}

  const buildToolDir = path.join(r, "build-tools", "34.0.0");
  const buildToolsInstalled =
    fs.existsSync(path.join(buildToolDir, process.platform === "win32" ? "aapt.exe" : "aapt")) &&
    fs.existsSync(path.join(buildToolDir, process.platform === "win32" ? "apksigner.bat" : "apksigner"));
  const needsInstall: string[] = [];
  if (!buildToolsInstalled) needsInstall.push("build-tools;34.0.0");
  if (!platToolsInstalled) needsInstall.push("platform-tools");
  if (!emuInstalled) needsInstall.push("emulator");
  if (!cmdlineInstalled) needsInstall.push("cmdline-tools");
  if (!systemImageInstalled && !anySystemImage) needsInstall.push(DEFAULT_SYSTEM_IMAGE);

  let totalMB = 0;
  if (!buildToolsInstalled) totalMB += 55;
  if (!platToolsInstalled) totalMB += 12;
  if (!emuInstalled) totalMB += 250;
  if (!cmdlineInstalled) totalMB += 150;
  if (!systemImageInstalled && !anySystemImage) totalMB += 900;

  const revision = (dir: string) => {
    try { return fs.readFileSync(path.join(dir, "source.properties"), "utf8").match(/^Pkg.Revision\s*=\s*(.+)$/m)?.[1]?.trim(); } catch { return undefined; }
  };
  const platformToolsVersion = revision(path.join(r, "platform-tools"));
  const emulatorVersion = revision(path.join(r, "emulator"));

  return {
    installed: needsInstall.length === 0,
    sdkRoot: r,
    components: {
      buildTools: { installed: buildToolsInstalled, path: buildToolsInstalled ? buildToolDir : null },
      platformTools: { installed: platToolsInstalled, path: platToolsInstalled ? platToolsPath : null, version: platformToolsVersion },
      emulator: { installed: emuInstalled, path: emuInstalled ? emuPath : null, version: emulatorVersion },
      cmdlineTools: { installed: cmdlineInstalled, path: cmdlineInstalled ? avdm : null },
      systemImage: {
        installed: systemImageInstalled || !!anySystemImage,
        apiLevel: DEFAULT_API_LEVEL,
        variant: "google_apis",
        path: anySystemImage || (systemImageInstalled ? systemImagePath : null),
      },
    },
    needsInstall,
    totalDownloadMB: totalMB,
  };
}

export type SdkInstallProgress = { phase: string; percent: number; message: string };

export async function installSdk(onProgress?: (p: SdkInstallProgress) => void, root?: string): Promise<void> {
  const r = root || sdkRoot();
  const plat = platform();
  const urls = SDK_URLS[plat];
  await mkdir(r, { recursive: true });

  const status = await getSdkStatus(r);

  if (!status.components.cmdlineTools.installed) {
    onProgress?.({ phase: "cmdline-tools", percent: 5, message: "Downloading Android cmdline-tools…" });
    const zip = path.join(r, "_tmp_cmdline.zip");
    try {
      await downloadFile(urls.cmdlineTools, zip, (rec, tot) => {
        const pct = tot ? 5 + Math.round((rec / tot) * 10) : 5;
        onProgress?.({ phase: "cmdline-tools", percent: pct, message: `Downloading cmdline-tools ${(rec / 1024 / 1024).toFixed(1)} MB${tot ? ` / ${(tot / 1024 / 1024).toFixed(1)} MB` : ""}` });
      });
      onProgress?.({ phase: "cmdline-tools", percent: 15, message: "Extracting cmdline-tools…" });
      const tmpExtract = path.join(r, "_tmp_cmdline_extract");
      await rm(tmpExtract, { recursive: true, force: true });
      await mkdir(tmpExtract, { recursive: true });
      await unzipSafe(zip, tmpExtract);
      const src = path.join(tmpExtract, "cmdline-tools");
      const dest = path.join(r, "cmdline-tools");
      await rm(dest, { recursive: true, force: true });
      let inner: string | null = null;
      try {
        const entries = await readdir(src);
        if (entries.includes("bin")) inner = src;
        else if (entries.length === 1) inner = path.join(src, entries[0]);
        else inner = src;
      } catch {
        inner = tmpExtract;
      }
      const latest = path.join(dest, "latest");
      await mkdir(latest, { recursive: true });
      await fs.promises.cp(inner, latest, { recursive: true });
      await rm(tmpExtract, { recursive: true, force: true });
    } finally {
      await rm(zip, { force: true }).catch(() => {});
    }
    onProgress?.({ phase: "cmdline-tools", percent: 20, message: "cmdline-tools ready" });
  }

  if (!status.components.platformTools.installed) {
    onProgress?.({ phase: "platform-tools", percent: 22, message: "Downloading platform-tools…" });
    const zip = path.join(r, "_tmp_platform.zip");
    try {
      await downloadFile(urls.platformTools, zip, (rec, tot) => {
        const pct = tot ? 22 + Math.round((rec / tot) * 5) : 24;
        onProgress?.({ phase: "platform-tools", percent: pct, message: `Downloading platform-tools ${(rec / 1024 / 1024).toFixed(1)} MB` });
      });
      onProgress?.({ phase: "platform-tools", percent: 27, message: "Extracting platform-tools…" });
      await unzipSafe(zip, r);
    } finally {
      await rm(zip, { force: true }).catch(() => {});
    }
    onProgress?.({ phase: "platform-tools", percent: 30, message: "platform-tools ready" });
    if (process.platform !== "win32") {
      try { await execFileAsync("chmod", ["+x", getAdbPath(r)]); } catch {}
    }
  }

  if (!status.components.emulator.installed) {
    onProgress?.({ phase: "emulator", percent: 32, message: "Downloading Android Emulator…" });
    const zip = path.join(r, "_tmp_emu.zip");
    try {
      await downloadFile(urls.emulator, zip, (rec, tot) => {
        const pct = tot ? 32 + Math.round((rec / tot) * 10) : 36;
        onProgress?.({ phase: "emulator", percent: pct, message: `Downloading emulator ${(rec / 1024 / 1024).toFixed(1)} MB` });
      });
      onProgress?.({ phase: "emulator", percent: 42, message: "Extracting emulator…" });
      await unzipSafe(zip, r);
    } finally {
      await rm(zip, { force: true }).catch(() => {});
    }
    if (process.platform !== "win32") {
      try { await execFileAsync("chmod", ["+x", getEmulatorPath(r)]); } catch {}
    }
    onProgress?.({ phase: "emulator", percent: 50, message: "emulator ready" });
  }

  if (!status.components.systemImage.installed || !status.components.buildTools?.installed) {
    onProgress?.({ phase: "system-image", percent: 52, message: "Installing system image (this may take several minutes)…" });
    const sdkMgr = getSdkManagerPath(r);
    if (!existsSync(sdkMgr)) throw new Error(`sdkmanager not found at ${sdkMgr}. cmdline-tools install may have failed.`);

    const packages = [
      `platforms;android-${DEFAULT_API_LEVEL}`,
      DEFAULT_SYSTEM_IMAGE,
      "build-tools;34.0.0",
    ];

    for (let i = 0; i < packages.length; i++) {
      const pkg = packages[i];
      const pct = 55 + Math.round((i / packages.length) * 40);
      onProgress?.({ phase: "system-image", percent: pct, message: `Installing ${pkg}…` });
      try {
        await new Promise<void>((resolve, reject) => {
          const proc = spawnSdk(sdkMgr, ["--install", pkg, "--sdk_root=" + r], {
            stdio: ["pipe", "pipe", "pipe"],
          });
          let stderr = "";
          proc.stdout?.on("data", d => {
            const s = String(d);
            if (s.includes("%") && onProgress) onProgress({ phase: "system-image", percent: pct, message: s.trim().slice(0, 120) });
          });
          proc.stderr?.on("data", d => { stderr += String(d); });
          proc.stdin?.end("y\ny\ny\ny\ny\n");
          const timer = setTimeout(() => {
            try { proc.kill(); } catch {}
            reject(new Error(`sdkmanager timeout for ${pkg}`));
          }, 600000);
          proc.on("close", code => {
            clearTimeout(timer);
            if (code === 0) resolve();
            else reject(new Error(`sdkmanager failed for ${pkg} (exit ${code}): ${stderr.slice(0, 500)}`));
          });
          proc.on("error", e => {
            clearTimeout(timer);
            reject(e);
          });
        });
      } catch (e: any) {
        throw new Error(`SDK installation failed for ${pkg}: ${e.message}. Retry after checking Java, storage and network connectivity.`);
      }
    }
    onProgress?.({ phase: "system-image", percent: 95, message: "System image ready" });
  }

  const verified = await getSdkStatus(r);
  if (!verified.installed) throw new Error(`SDK incomplete: ${verified.needsInstall.join(", ")}`);
  onProgress?.({ phase: "done", percent: 100, message: "Android SDK ready" });
}

export async function listSystemImages(root?: string): Promise<SystemImageInfo[]> {
  const r = root || sdkRoot();
  const status = await getSdkStatus(r);
  const catalog: SystemImageInfo[] = [
    { id: "system-images;android-34;google_apis;x86_64", apiLevel: 34, variant: "google_apis", abi: "x86_64", tag: "google_apis", description: "Android 14 (API 34) · Google APIs · x86_64", downloadSizeMB: 900, installed: status.components.systemImage.installed && status.components.systemImage.apiLevel === 34 },
    { id: "system-images;android-34;google_apis_playstore;x86_64", apiLevel: 34, variant: "google_apis_playstore", abi: "x86_64", tag: "google_apis_playstore", description: "Android 14 (API 34) · Google Play Store · x86_64", downloadSizeMB: 1100, installed: false },
    { id: "system-images;android-33;google_apis;x86_64", apiLevel: 33, variant: "google_apis", abi: "x86_64", tag: "google_apis", description: "Android 13 (API 33) · Google APIs · x86_64", downloadSizeMB: 850, installed: false },
    { id: "system-images;android-32;google_apis;x86_64", apiLevel: 32, variant: "google_apis", abi: "x86_64", tag: "google_apis", description: "Android 12L (API 32) · Google APIs · x86_64", downloadSizeMB: 800, installed: false },
    { id: "system-images;android-34;google_apis;arm64-v8a", apiLevel: 34, variant: "google_apis", abi: "arm64-v8a", tag: "google_apis", description: "Android 14 (API 34) · Google APIs · arm64-v8a (for Apple Silicon)", downloadSizeMB: 950, installed: false },
  ];
  for (const item of catalog) {
    const p = path.join(r, item.id.replace(/;/g, path.sep));
    if (existsSync(p) && existsSync(path.join(p, "system.img"))) item.installed = true;
  }
  return catalog;
}
