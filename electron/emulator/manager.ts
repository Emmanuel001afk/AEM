import fs from "fs";
import path from "path";
import { app } from "electron";
import { getSdkRoot, getUserDataPath, DEFAULT_AVD_NAME, DEFAULT_SYSTEM_IMAGE } from "../config";
import { runDiagnostics } from "./diagnostics";
import { getSdkStatus, installSdk, listSystemImages } from "./sdk";
import { listAvds, getAvdInfo, createAvd, deleteAvd, wipeAvd, updateAvdConfig } from "./avd";
import { EmulatorInstance } from "./instance";
import { adbInstall, adbInstallMultiple, adbListInstalledApps, adbLaunchApp, adbUninstall, adbDevices, adbGetPackageInfo, adbGrantPermission, adbRevokePermission, adbClearData, adbForceStop, adbPush, adbPull, adbShell, adbGetPermissions, adbExec, adbStartServer } from "./adb";
import type { EmulatorStatus, SdkStatus, DiagnosticsResult, AvdInfo, AvdCreateOptions, InstalledApp, InstallResult, EmulatorLaunchOptions, ApkInfo } from "./types";
import { createHash } from "crypto";

let instance: EmulatorManager | null = null;

export class EmulatorManager {
  private sdkRoot: string;
  private emu: EmulatorInstance;
  private status: EmulatorStatus = { state: "not-installed", avdName: null, pid: null, adbSerial: null, uptimeMs: null, bootCompleted: false, lastError: null };
  private diagnosticsCache: DiagnosticsResult | null = null;
  private logs: string[] = [];

  constructor() {
    this.sdkRoot = getSdkRoot();
    this.emu = new EmulatorInstance(this.sdkRoot, s => {
      this.status = s;
      this.log(`[status] ${s.state} avd=${s.avdName} serial=${s.adbSerial} err=${s.lastError || ""}`);
    });
    // Initial status sync
    this.status = this.emu.getStatus();
  }

  static getInstance(): EmulatorManager {
    if (!instance) instance = new EmulatorManager();
    return instance;
  }

  private log(msg: string) {
    const line = `[${new Date().toISOString()}] ${msg}`;
    this.logs.push(line);
    if (this.logs.length > 1000) this.logs.shift();
    console.log(line);
  }

  async getStatus(): Promise<EmulatorStatus> {
    // Merge with SDK check
    const sdk = await getSdkStatus(this.sdkRoot).catch(() => null);
    const emuStatus = this.emu.getStatus();
    if (sdk && !sdk.installed) {
      return { ...emuStatus, state: "not-installed", lastError: `SDK components missing: ${sdk.needsInstall.join(", ")}` };
    }
    // If emu says not-installed but sdk is installed, mark ready if no AVD running
    if (emuStatus.state === "not-installed" && sdk?.installed) {
      const avds = await listAvds(this.sdkRoot).catch(() => []);
      return { ...emuStatus, state: avds.length ? "ready" : "not-installed", lastError: avds.length ? null : "No AVD created yet" };
    }
    return emuStatus;
  }

  async getDiagnostics(force = false): Promise<DiagnosticsResult> {
    if (!force && this.diagnosticsCache && Date.now() - new Date(this.diagnosticsCache.timestamp).getTime() < 30000) {
      return this.diagnosticsCache;
    }
    const d = await runDiagnostics(getUserDataPath());
    this.diagnosticsCache = d;
    return d;
  }

  async getSdkStatus(): Promise<SdkStatus> {
    return getSdkStatus(this.sdkRoot);
  }

  async installSdk(onProgress?: (p: { phase: string; percent: number; message: string }) => void): Promise<SdkStatus> {
    this.status = { ...this.status, state: "installing", lastError: null, progress: { phase: "sdk", percent: 0, message: "Preparing SDK installation…" } };
    await installSdk(p => {
      this.status = { ...this.status, progress: p as any };
      onProgress?.(p);
    }, this.sdkRoot);
    this.status = { ...this.status, state: "ready", progress: undefined, lastError: null };
    return this.getSdkStatus();
  }

  async listAvds(): Promise<AvdInfo[]> { return listAvds(this.sdkRoot); }
  async getAvdInfo(name: string): Promise<AvdInfo | null> { return getAvdInfo(name); }
  async listSystemImages() { return listSystemImages(this.sdkRoot); }

  async createAvd(options: AvdCreateOptions): Promise<AvdInfo> {
    const sdk = await getSdkStatus(this.sdkRoot);
    if (!sdk.installed) throw new Error(`SDK not ready: missing ${sdk.needsInstall.join(", ")}. Install SDK first.`);
    this.log(`Creating AVD ${options.name} with image ${options.systemImage}`);
    const avd = await createAvd(options, this.sdkRoot);
    this.log(`AVD created: ${avd.name} at ${avd.path}`);
    return avd;
  }

  async ensureDefaultAvd(): Promise<AvdInfo> {
    const existing = await getAvdInfo(DEFAULT_AVD_NAME);
    if (existing) return existing;
    const sdk = await getSdkStatus(this.sdkRoot);
    if (!sdk.installed) throw new Error("SDK not installed — cannot create default AVD");
    // Determine best available system image
    const images = await listSystemImages();
    const preferred = images.find(i => i.id === DEFAULT_SYSTEM_IMAGE && i.installed) || images.find(i => i.installed) || { id: DEFAULT_SYSTEM_IMAGE } as any;
    return this.createAvd({
      name: DEFAULT_AVD_NAME,
      systemImage: preferred.id || DEFAULT_SYSTEM_IMAGE,
      device: "pixel_7",
      ramMB: 3072,
      heapMB: 512,
      storageMB: 8192,
      cores: 4,
      gpuMode: "auto",
      snapshot: true,
    });
  }

  async deleteAvd(name: string): Promise<boolean> {
    if (this.emu.getStatus().avdName === name && this.emu.isRunning()) {
      throw new Error(`Cannot delete running AVD ${name}. Stop emulator first.`);
    }
    return deleteAvd(name);
  }

  async wipeAvd(name: string): Promise<void> {
    if (this.emu.isRunning()) throw new Error("Stop emulator before wiping data");
    return wipeAvd(name);
  }

  async updateAvd(name: string, patch: Partial<AvdCreateOptions>): Promise<AvdInfo | null> {
    return updateAvdConfig(name, patch);
  }

  async start(options: EmulatorLaunchOptions = {}): Promise<EmulatorStatus> {
    const diag = await this.getDiagnostics();
    if (!diag.summary.canRun) {
      const fails = diag.checks.filter(c => c.status === "fail" && c.required).map(c => c.label).join(", ");
      throw new Error(`Host cannot run emulator: ${fails}. Check diagnostics for fixes.`);
    }
    const sdk = await getSdkStatus(this.sdkRoot);
    if (!sdk.installed) throw new Error(`SDK missing: ${sdk.needsInstall.join(", ")}`);

    // Ensure AVD exists
    const avdName = options.avdName || DEFAULT_AVD_NAME;
    let avd = await getAvdInfo(avdName);
    if (!avd) {
      // Try to create default
      avd = await this.ensureDefaultAvd();
    }

    // If options specify overrides, patch config before start
    if (options.ramMB || options.cores || options.gpuMode) {
      await updateAvdConfig(avdName, { ramMB: options.ramMB, cores: options.cores, gpuMode: options.gpuMode as any });
    }

    this.log(`Starting emulator AVD ${avdName} bootMode=${options.bootMode || "quick"}`);
    return this.emu.start({ ...options, avdName });
  }

  async stop(): Promise<EmulatorStatus> {
    await this.emu.stop();
    return this.getStatus();
  }

  async restart(options?: EmulatorLaunchOptions): Promise<EmulatorStatus> {
    return this.emu.restart(options);
  }

  private async requireSerial(): Promise<string> {
    const s = this.emu.getStatus();
    if (s.adbSerial) return s.adbSerial;
    // Fallback: query adb devices
    const devices = await adbDevices(this.sdkRoot);
    const emu = devices.find(d => d.startsWith("emulator-"));
    if (emu) return emu;
    throw new Error("Emulator not running — no ADB device found. Start emulator first.");
  }

  async getInstalledApps(): Promise<InstalledApp[]> {
    const serial = await this.requireSerial();
    return adbListInstalledApps(this.sdkRoot, serial);
  }

  async installApk(filePath: string, options: { reinstall?: boolean; grantPermissions?: boolean; allowDowngrade?: boolean } = {}): Promise<InstallResult> {
    const start = Date.now();
    if (!fs.existsSync(filePath)) throw new Error(`APK file not found: ${filePath}`);
    const serial = await this.requireSerial();
    const lower = filePath.toLowerCase();
    let result: any;

    if (lower.endsWith(".apks") || lower.endsWith(".xapk") || lower.endsWith(".apkm") || lower.endsWith(".zip")) {
      // Extract and install-multiple
      const dir = path.join(path.dirname(filePath), `.aem_extract_${Date.now()}`);
      await fs.promises.mkdir(dir, { recursive: true });
      try {
        // Extract apks
        const apks: string[] = [];
        if (process.platform === "win32") {
          const { execSync } = await import("child_process");
          execSync(`powershell -Command "Expand-Archive -Path '${filePath}' -DestinationPath '${dir}' -Force"`, { timeout: 30000 });
          const walk = (d: string) => {
            for (const e of fs.readdirSync(d)) {
              const p = path.join(d, e);
              if (fs.statSync(p).isDirectory()) walk(p);
              else if (p.toLowerCase().endsWith(".apk")) apks.push(p);
            }
          };
          walk(dir);
        } else {
          const { execFileSync } = await import("child_process");
          execFileSync("unzip", ["-o", filePath, "-d", dir]);
          const walk = (d: string) => {
            for (const e of fs.readdirSync(d)) {
              const p = path.join(d, e);
              if (fs.statSync(p).isDirectory()) walk(p);
              else if (p.toLowerCase().endsWith(".apk")) apks.push(p);
            }
          };
          walk(dir);
        }
        if (apks.length === 0) throw new Error("No APK files found inside archive");
        result = await adbInstallMultiple(this.sdkRoot, serial, apks, { reinstall: options.reinstall ?? true, grantPermissions: options.grantPermissions });
      } finally {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      }
    } else {
      result = await adbInstall(this.sdkRoot, serial, filePath, { reinstall: options.reinstall ?? true, grantPermissions: options.grantPermissions, allowDowngrade: options.allowDowngrade });
    }

    const durationMs = Date.now() - start;
    const success = result.success || /success/i.test(result.stdout);
    const msg = success ? `Installed ${path.basename(filePath)}` : (result.stderr || result.stdout || "Install failed");

    // Try to get package name from apk via aapt or from result
    let pkg: string | undefined;
    const m = (result.stdout + result.stderr).match(/pkg:\s*([a-z0-9._]+)/i) || msg.match(/([a-z0-9._]+\.[a-z0-9._]+)/);
    if (m) pkg = m[1];

    return { success, packageName: pkg, message: msg, durationMs };
  }

  async installApkFromUrl(url: string, fileName: string): Promise<InstallResult> {
    // Download to temp, then install
    const tmpDir = path.join(app.getPath("temp"), "aem-apk-downloads");
    await fs.promises.mkdir(tmpDir, { recursive: true });
    const filePath = path.join(tmpDir, fileName.replace(/[^A-Za-z0-9._-]/g, "_"));
    // Use fetch or http get
    const https = await import("https");
    const http = await import("http");
    const { createWriteStream } = await import("fs");
    await new Promise<void>((resolve, reject) => {
      const client = url.startsWith("https:") ? https : http;
      const file = createWriteStream(filePath);
      client.get(url, res => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          // redirect
          const redir = res.headers.location;
          client.get(redir, res2 => {
            res2.pipe(file);
            file.on("finish", () => file.close(() => resolve()));
            res2.on("error", reject);
          }).on("error", reject);
          return;
        }
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        res.pipe(file);
        file.on("finish", () => file.close(() => resolve()));
        res.on("error", reject);
      }).on("error", reject);
    });
    return this.installApk(filePath);
  }

  async uninstallApp(packageName: string, keepData = false): Promise<{ success: boolean; message: string }> {
    const serial = await this.requireSerial();
    const r = await adbUninstall(this.sdkRoot, serial, packageName, keepData);
    return { success: r.success || /success/i.test(r.stdout), message: r.stdout || r.stderr };
  }

  async launchApp(packageName: string, activity?: string): Promise<{ success: boolean; message: string }> {
    const serial = await this.requireSerial();
    const r = await adbLaunchApp(this.sdkRoot, serial, packageName, activity);
    return { success: r.success, message: r.stdout || r.stderr || (r.success ? "Launched" : "Failed to launch") };
  }

  async getAppInfo(packageName: string): Promise<any> {
    const serial = await this.requireSerial();
    return adbGetPackageInfo(this.sdkRoot, serial, packageName);
  }

  async getAppPermissions(packageName: string): Promise<{ requested: string[]; granted: string[] }> {
    const serial = await this.requireSerial();
    return adbGetPermissions(this.sdkRoot, serial, packageName);
  }

  async grantPermission(packageName: string, permission: string): Promise<boolean> {
    const serial = await this.requireSerial();
    const r = await adbGrantPermission(this.sdkRoot, serial, packageName, permission);
    return r.success;
  }

  async revokePermission(packageName: string, permission: string): Promise<boolean> {
    const serial = await this.requireSerial();
    const r = await adbRevokePermission(this.sdkRoot, serial, packageName, permission);
    return r.success;
  }

  async clearAppData(packageName: string): Promise<boolean> {
    const serial = await this.requireSerial();
    const r = await adbClearData(this.sdkRoot, serial, packageName);
    return r.success;
  }

  async forceStop(packageName: string): Promise<boolean> {
    const serial = await this.requireSerial();
    const r = await adbForceStop(this.sdkRoot, serial, packageName);
    return r.success;
  }

  async pushFile(localPath: string, remotePath: string): Promise<boolean> {
    const serial = await this.requireSerial();
    const r = await adbPush(this.sdkRoot, serial, localPath, remotePath);
    return r.success;
  }

  async pullFile(remotePath: string, localPath: string): Promise<boolean> {
    const serial = await this.requireSerial();
    const r = await adbPull(this.sdkRoot, serial, remotePath, localPath);
    return r.success;
  }

  async shell(command: string): Promise<string> {
    const serial = await this.requireSerial();
    const r = await adbShell(this.sdkRoot, serial, command);
    return r.stdout || r.stderr;
  }

  async getApkInfo(filePath: string): Promise<ApkInfo> {
    const stat = fs.statSync(filePath);
    const info: ApkInfo = {
      fileName: path.basename(filePath),
      filePath,
      fileSizeMB: stat.size / 1024 / 1024,
      valid: false,
    };
    try {
      // Try aapt dump badging
      const buildToolsDir = path.join(this.sdkRoot, "build-tools");
      let aapt: string | null = null;
      if (fs.existsSync(buildToolsDir)) {
        const versions = fs.readdirSync(buildToolsDir).sort().reverse();
        for (const v of versions) {
          const candidate = path.join(buildToolsDir, v, process.platform === "win32" ? "aapt.exe" : "aapt");
          if (fs.existsSync(candidate)) { aapt = candidate; break; }
        }
      }
      if (aapt) {
        const { execFileSync } = await import("child_process");
        const out = execFileSync(aapt, ["dump", "badging", filePath], { encoding: "utf8", timeout: 10000, maxBuffer: 5 * 1024 * 1024 });
        info.packageName = out.match(/package: name='([^']+)'/)?.[1];
        info.versionName = out.match(/versionName='([^']+)'/)?.[1];
        info.versionCode = parseInt(out.match(/versionCode='(\d+)'/)?.[1] || "0", 10) || undefined;
        info.minSdk = parseInt(out.match(/sdkVersion:'(\d+)'/)?.[1] || "0", 10) || undefined;
        info.targetSdk = parseInt(out.match(/targetSdkVersion:'(\d+)'/)?.[1] || "0", 10) || undefined;
        info.permissions = [...out.matchAll(/uses-permission: name='([^']+)'/g)].map(m => m[1]);
        info.valid = !!info.packageName;
      } else {
        // Fallback: try to unzip and read AndroidManifest.xml binary? Mark as potentially valid if zip contains .dex
        // For now, check if it's a zip with apk signature
        const isZip = (() => {
          const fd = fs.openSync(filePath, "r");
          const buf = Buffer.alloc(4);
          fs.readSync(fd, buf, 0, 4, 0);
          fs.closeSync(fd);
          return buf[0] === 0x50 && buf[1] === 0x4b; // PK
        })();
        info.valid = isZip && filePath.toLowerCase().endsWith(".apk");
        if (!info.valid && (filePath.toLowerCase().endsWith(".apks") || filePath.toLowerCase().endsWith(".xapk"))) info.valid = isZip;
      }
      // SHA256
      const h = createHash("sha256");
      const s = fs.createReadStream(filePath);
      for await (const chunk of s) h.update(chunk);
      info.sha256 = h.digest("hex");
    } catch (e: any) {
      info.error = e.message;
      info.valid = false;
    }
    return info;
  }

  async takeScreenshot(): Promise<{ success: boolean; dataBase64?: string; error?: string }> {
    const serial = await this.requireSerial();
    const tmpLocal = path.join(app.getPath("temp"), `aem_screenshot_${Date.now()}.png`);
    const remote = `/sdcard/Pictures/aem_screenshot_${Date.now()}.png`;
    try {
      // screencap to file then pull
      const r1 = await adbExec(this.sdkRoot, ["-s", serial, "shell", `screencap -p ${remote} && echo OK`]);
      if (!r1.success) return { success: false, error: r1.stderr };
      const r2 = await adbPull(this.sdkRoot, serial, remote, tmpLocal);
      if (!r2.success) return { success: false, error: r2.stderr };
      const b64 = fs.readFileSync(tmpLocal).toString("base64");
      try { fs.unlinkSync(tmpLocal); } catch {}
      try { await adbExec(this.sdkRoot, ["-s", serial, "shell", `rm ${remote}`]); } catch {}
      return { success: true, dataBase64: b64 };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  async setLocation(lat: number, lng: number): Promise<boolean> {
    const serial = await this.requireSerial();
    const r = await adbExec(this.sdkRoot, ["-s", serial, "emu", "geo", "fix", String(lng), String(lat)]);
    return r.success;
  }

  async rotate(rotation: 0 | 1 | 2 | 3): Promise<boolean> {
    const serial = await this.requireSerial();
    const r = await adbShell(this.sdkRoot, serial, `settings put system user_rotation ${rotation}`);
    return true;
  }

  async getLogs(limit = 200): Promise<string[]> {
    const emuLogs = this.emu.getLogs(limit);
    const combined = [...this.logs.slice(-limit), ...emuLogs.map(l => `[${l.timestamp}] [${l.source}] ${l.message}`)];
    return combined.slice(-limit);
  }

  async startAdbServer(): Promise<void> { await adbStartServer(this.sdkRoot); }

  async getVersionInfo(): Promise<{ emulator?: string; adb?: string; apiLevel?: number }> {
    const sdk = await getSdkStatus(this.sdkRoot);
    return { emulator: sdk.components.emulator.version, adb: sdk.components.platformTools.version, apiLevel: sdk.components.systemImage.apiLevel };
  }
}
