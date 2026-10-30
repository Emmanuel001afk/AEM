import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import https from "https";
import http from "http";
import { createWriteStream, existsSync } from "fs";
import { mkdir, rm, readdir } from "fs/promises";
import { pipeline } from "stream/promises";
import { getSdkRoot, SDK_URLS, DEFAULT_SYSTEM_IMAGE, DEFAULT_API_LEVEL } from "../config";
import type { SdkStatus, SystemImageInfo } from "./types";
import { createHash } from "crypto";
import { spawn } from "child_process";

const execFileAsync = promisify(execFile);

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
  // cmdline-tools/latest/bin/avdmanager
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
  await mkdir(path.dirname(dest), { recursive: true });
  return new Promise<void>((resolve, reject) => {
    const file = createWriteStream(dest);
    const client = url.startsWith("https:") ? https : http;
    const req = client.get(url, { headers: { "User-Agent": "AEM-Store/0.1.0" } }, res => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // redirect
        file.close();
        // recurse once
        downloadFile(res.headers.location, dest, onProgress).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`Download failed ${res.statusCode} for ${url}`));
        return;
      }
      const total = parseInt(res.headers["content-length"] || "0", 10);
      let received = 0;
      res.on("data", chunk => {
        received += chunk.length;
        if (onProgress) onProgress(received, total);
      });
      res.pipe(file);
      file.on("finish", () => {
        file.close(() => resolve());
      });
    });
    req.on("error", reject);
    file.on("error", reject);
    req.setTimeout(120000, () => {
      req.destroy(new Error(`Timeout downloading ${url}`));
    });
  });
}

async function unzip(zipPath: string, destDir: string): Promise<void> {
  // Try system unzip first, fallback to Node adm-zip if available
  try {
    if (process.platform === "win32") {
      // Use PowerShell Expand-Archive
      await execFileAsync("powershell", ["-Command", `Expand-Archive -Path "${zipPath}" -DestinationPath "${destDir}" -Force`], { timeout: 120000 });
    } else {
      await execFileAsync("unzip", ["-o", zipPath, "-d", destDir], { timeout: 120000 });
    }
    return;
  } catch {}
  // Fallback: try adm-zip if installed, else error
  try {
    // @ts-ignore
    const AdmZip: any = (await import("adm-zip" as any)).default;
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(destDir, true);
    return;
  } catch (e: any) {
    throw new Error(`Failed to unzip ${zipPath}: ${e.message}. Please install unzip.`);
  }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
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

  // Fallback check: any system-images present
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

  const needsInstall: string[] = [];
  if (!platToolsInstalled) needsInstall.push("platform-tools");
  if (!emuInstalled) needsInstall.push("emulator");
  if (!cmdlineInstalled) needsInstall.push("cmdline-tools");
  if (!systemImageInstalled && !anySystemImage) needsInstall.push(DEFAULT_SYSTEM_IMAGE);

  // Estimate download sizes
  let totalMB = 0;
  if (!platToolsInstalled) totalMB += 12;
  if (!emuInstalled) totalMB += 250;
  if (!cmdlineInstalled) totalMB += 150;
  if (!systemImageInstalled && !anySystemImage) totalMB += 900;

  let platformToolsVersion: string | undefined;
  if (platToolsInstalled) {
    try {
      const out = await execFileAsync(platToolsPath, ["--version"], { timeout: 5000 });
      platformToolsVersion = String(out.stdout || out.stderr || "").trim().split("\n")[0]?.slice(0, 80);
    } catch {}
  }

  let emulatorVersion: string | undefined;
  if (emuInstalled) {
    try {
      const out = await execFileAsync(emuPath, ["-version"], { timeout: 5000 });
      emulatorVersion = String(out.stdout || out.stderr || "").trim().split("\n")[0]?.slice(0, 120);
    } catch {}
  }

  return {
    installed: needsInstall.length === 0,
    sdkRoot: r,
    components: {
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

  // 1. cmdline-tools
  if (!status.components.cmdlineTools.installed) {
    onProgress?.({ phase: "cmdline-tools", percent: 5, message: "Downloading Android cmdline-tools…" });
    const zip = path.join(r, "_tmp_cmdline.zip");
    await downloadFile(urls.cmdlineTools, zip, (rec, tot) => {
      const pct = tot ? 5 + Math.round((rec / tot) * 10) : 5;
      onProgress?.({ phase: "cmdline-tools", percent: pct, message: `Downloading cmdline-tools ${(rec / 1024 / 1024).toFixed(1)} MB${tot ? ` / ${(tot / 1024 / 1024).toFixed(1)} MB` : ""}` });
    });
    onProgress?.({ phase: "cmdline-tools", percent: 15, message: "Extracting cmdline-tools…" });
    const tmpExtract = path.join(r, "_tmp_cmdline_extract");
    await rm(tmpExtract, { recursive: true, force: true });
    await mkdir(tmpExtract, { recursive: true });
    await unzip(zip, tmpExtract);
    // cmdline-tools zip contains cmdline-tools/ folder
    const src = path.join(tmpExtract, "cmdline-tools");
    const dest = path.join(r, "cmdline-tools");
    await rm(dest, { recursive: true, force: true });
    // Move cmdline-tools/cmdline-tools or cmdline-tools/* to cmdline-tools/latest
    let inner: string | null = null;
    try {
      const entries = await readdir(src);
      // If zip contains directly bin/lib etc, otherwise nested
      if (entries.includes("bin")) inner = src;
      else if (entries.length === 1) inner = path.join(src, entries[0]);
      else inner = src;
    } catch {
      inner = tmpExtract;
    }
    const latest = path.join(dest, "latest");
    await mkdir(latest, { recursive: true });
    // Copy inner to latest
    if (process.platform === "win32") {
      await execFileAsync("powershell", ["-Command", `Copy-Item -Path "${inner}\\*" -Destination "${latest}" -Recurse -Force`], { timeout: 60000 });
    } else {
      await execFileAsync("cp", ["-a", `${inner}/.`, latest], { timeout: 60000 });
    }
    await rm(zip, { force: true });
    await rm(tmpExtract, { recursive: true, force: true });
    onProgress?.({ phase: "cmdline-tools", percent: 20, message: "cmdline-tools ready" });
  }

  // 2. platform-tools
  if (!status.components.platformTools.installed) {
    onProgress?.({ phase: "platform-tools", percent: 22, message: "Downloading platform-tools…" });
    const zip = path.join(r, "_tmp_platform.zip");
    await downloadFile(urls.platformTools, zip);
    onProgress?.({ phase: "platform-tools", percent: 26, message: "Extracting platform-tools…" });
    await unzip(zip, r);
    await rm(zip, { force: true });
    onProgress?.({ phase: "platform-tools", percent: 30, message: "platform-tools ready" });
    // Fix permissions on unix
    if (process.platform !== "win32") {
      try { await execFileAsync("chmod", ["+x", getAdbPath(r)]); } catch {}
    }
  }

  // 3. emulator
  if (!status.components.emulator.installed) {
    onProgress?.({ phase: "emulator", percent: 32, message: "Downloading Android Emulator…" });
    const zip = path.join(r, "_tmp_emu.zip");
    await downloadFile(urls.emulator, zip);
    onProgress?.({ phase: "emulator", percent: 42, message: "Extracting emulator…" });
    await unzip(zip, r);
    await rm(zip, { force: true });
    if (process.platform !== "win32") {
      try { await execFileAsync("chmod", ["+x", getEmulatorPath(r)]); } catch {}
    }
    onProgress?.({ phase: "emulator", percent: 50, message: "emulator ready" });
  }

  // 4. system image & platform via sdkmanager
  if (!status.components.systemImage.installed) {
    onProgress?.({ phase: "system-image", percent: 52, message: "Installing system image (this may take several minutes)…" });
    const sdkMgr = getSdkManagerPath(r);
    if (!existsSync(sdkMgr)) throw new Error(`sdkmanager not found at ${sdkMgr}. cmdline-tools install may have failed.`);

    // Accept licenses automatically
    const licenses = path.join(r, "licenses");
    await mkdir(licenses, { recursive: true });
    // Create dummy license files to avoid interactive prompt
    try {
      fs.writeFileSync(path.join(licenses, "android-sdk-license"), "8933bad161af4178b1185d1a37fbf41ea5269c55\n", { flag: "w" });
      fs.writeFileSync(path.join(licenses, "android-sdk-preview-license"), "84831b9409646a918e30573bab4c9c91346d8abd\n", { flag: "w" });
    } catch {}

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
          const proc = spawn(sdkMgr, ["--install", pkg, "--sdk_root=" + r], {
            stdio: ["pipe", "pipe", "pipe"],
          });
          let stderr = "";
          proc.stdout?.on("data", d => { const s = String(d); if (s.includes("%") && onProgress) onProgress({ phase: "system-image", percent: pct, message: s.trim().slice(0, 120) }); });
          proc.stderr?.on("data", d => { stderr += String(d); });
          proc.stdin?.write("y\n");
          setTimeout(() => { try { proc.stdin?.write("y\n"); } catch {} }, 2000);
          proc.on("close", code => {
            if (code === 0) resolve();
            else reject(new Error(`sdkmanager failed for ${pkg} (exit ${code}): ${stderr.slice(0, 500)}`));
          });
          proc.on("error", reject);
          setTimeout(() => {
            try { proc.kill(); } catch {}
            reject(new Error(`sdkmanager timeout for ${pkg}`));
          }, 600000);
        });
      } catch (e: any) {
        // If system image install fails, try alternative ABI
        if (pkg === DEFAULT_SYSTEM_IMAGE) {
          const fallback = "system-images;android-33;google_apis;x86_64";
          onProgress?.({ phase: "system-image", percent: pct, message: `Primary image failed, trying fallback ${fallback}…` });
          try {
            await new Promise<void>((resolve, reject) => {
              const proc = spawn(sdkMgr, ["--install", fallback, "--sdk_root=" + r], { stdio: ["pipe", "pipe", "pipe"] });
              proc.stdin?.write("y\n");
              proc.on("close", c => c === 0 ? resolve() : reject(new Error(`fallback failed ${c}`)));
              proc.on("error", reject);
            });
          } catch {}
        } else {
          throw e;
        }
      }
    }
    onProgress?.({ phase: "system-image", percent: 95, message: "System image ready" });
  }

  onProgress?.({ phase: "done", percent: 100, message: "Android SDK ready" });
}

export async function listSystemImages(root?: string): Promise<SystemImageInfo[]> {
  const r = root || sdkRoot();
  const status = await getSdkStatus(r);
  // Known images catalog
  const catalog: SystemImageInfo[] = [
    { id: "system-images;android-34;google_apis;x86_64", apiLevel: 34, variant: "google_apis", abi: "x86_64", tag: "google_apis", description: "Android 14 (API 34) · Google APIs · x86_64", downloadSizeMB: 900, installed: status.components.systemImage.installed && status.components.systemImage.apiLevel === 34 },
    { id: "system-images;android-34;google_apis_playstore;x86_64", apiLevel: 34, variant: "google_apis_playstore", abi: "x86_64", tag: "google_apis_playstore", description: "Android 14 (API 34) · Google Play Store · x86_64", downloadSizeMB: 1100, installed: false },
    { id: "system-images;android-33;google_apis;x86_64", apiLevel: 33, variant: "google_apis", abi: "x86_64", tag: "google_apis", description: "Android 13 (API 33) · Google APIs · x86_64", downloadSizeMB: 850, installed: false },
    { id: "system-images;android-32;google_apis;x86_64", apiLevel: 32, variant: "google_apis", abi: "x86_64", tag: "google_apis", description: "Android 12L (API 32) · Google APIs · x86_64", downloadSizeMB: 800, installed: false },
    { id: "system-images;android-34;google_apis;arm64-v8a", apiLevel: 34, variant: "google_apis", abi: "arm64-v8a", tag: "google_apis", description: "Android 14 (API 34) · Google APIs · arm64-v8a (for Apple Silicon)", downloadSizeMB: 950, installed: false },
  ];
  // Check which are actually on disk
  for (const item of catalog) {
    const p = path.join(r, item.id.replace(/;/g, path.sep));
    if (existsSync(p) && existsSync(path.join(p, "system.img"))) item.installed = true;
  }
  return catalog;
}
