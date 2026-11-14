import fs from "fs";
import { extractPackage, inspectApk, selectPackageSet, assertCatalogCertificate } from "./packages";
import { downloadVerified } from "../download";
import { validateAllocation } from "./resources";
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

  async getResourceProfiles() {
    const d=await this.getDiagnostics(true);
    return {
      host:{...d.host,platform:process.platform,arch:process.arch,diskFreeMB:d.host.diskFreeMB??null,hypervisor:d.host.hypervisor??null,gpuInfo:d.host.gpuInfo??null},
      recommended:d.recommendation.supported?d.recommendation.profile:null,
      reasons:d.recommendation.reasons,
      limitations:d.recommendation.warnings,
      profiles:([['lightweight',1536],['balanced',2048],['standard',3072]] as const).map(([id,ramMB])=>({id,name:id,description:'Measured safe-budget policy; not a benchmark',ramMB,heapMB:ramMB<=2048?256:512,cores:d.recommendation.cores,storageMB:8192,gpuMode:'auto',snapshot:true,recommendedFor:'Only when current diagnostics permit this allocation'})),
    };
  }

  async listAvds(): Promise<AvdInfo[]> { return listAvds(this.sdkRoot); }
  async getAvdInfo(name: string): Promise<AvdInfo | null> { return getAvdInfo(name); }
  async listSystemImages() { return listSystemImages(this.sdkRoot); }

  async createAvd(options: AvdCreateOptions): Promise<AvdInfo> {
    const sdk = await getSdkStatus(this.sdkRoot);
    if (!sdk.installed) throw new Error(`SDK not ready: missing ${sdk.needsInstall.join(", ")}. Install SDK first.`);
    const d = await this.getDiagnostics(true);
    if (!d.recommendation.supported) throw new Error(d.recommendation.reasons.join(" "));
    options = { ...options, ramMB: options.ramMB ?? d.recommendation.ramMB, cores: options.cores ?? d.recommendation.cores };
    validateAllocation(options.ramMB!, options.cores!, d.recommendation, d.host.cpuCores);
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
      ramMB: (await this.getDiagnostics()).recommendation.ramMB,
      heapMB: (await this.getDiagnostics()).recommendation.ramMB <= 2048 ? 256 : 512,
      storageMB: 8192,
      cores: (await this.getDiagnostics()).recommendation.cores,
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
    const diag = await this.getDiagnostics(true);
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
      if (avdName !== DEFAULT_AVD_NAME) throw new Error(`AVD not found: ${avdName}`);
      avd = await this.ensureDefaultAvd();
    }

    validateAllocation(options.ramMB ?? avd.ramMB, options.cores ?? avd.cores, diag.recommendation, diag.host.cpuCores);

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
    await this.stop();
    return this.start(options);
  }

  private async requireSerial(): Promise<string> {
    const s = this.emu.getStatus();
    if (s.state === "running" && s.bootCompleted && s.adbSerial) return s.adbSerial;
    throw new Error("Managed emulator is not running. Start it in AEM first; other emulators are not selected implicitly.");
  }

  async getInstalledApps(): Promise<InstalledApp[]> {
    const serial = await this.requireSerial();
    return adbListInstalledApps(this.sdkRoot, serial);
  }

  async installApk(filePath: string, options: { reinstall?: boolean; grantPermissions?: boolean; allowDowngrade?: boolean; packageIdentity?: string; signingCertificateSha256?: string } = {}): Promise<InstallResult> {
    const start = Date.now();
    if (!fs.statSync(filePath).isFile()) throw new Error("Select a package file");
    const serial = await this.requireSerial();
    const staging = await fs.promises.mkdtemp(path.join(app.getPath("temp"), "aem-package-"));
    try {
      const files = /\.apk$/i.test(filePath) ? [filePath] : await extractPackage(filePath, staging);
      const metadata = [];
      for (const file of files) metadata.push(await inspectApk(file, this.sdkRoot));
      const api = await adbExec(this.sdkRoot,["-s",serial,"shell","getprop","ro.build.version.sdk"]);
      const abi = await adbExec(this.sdkRoot,["-s",serial,"shell","getprop","ro.product.cpu.abilist"]);
      if (!api.success || !abi.success || !Number(api.stdout.trim()) || !abi.stdout.trim()) throw new Error("Unable to inspect target API/ABI; no installation attempted");
      const selected = selectPackageSet(metadata,{api:Number(api.stdout.trim()),abis:abi.stdout.trim().split(",")});
      const base = selected.find(p=>!p.split)!;
      if (options.packageIdentity && options.packageIdentity !== base.packageName) throw new Error("Catalog package identity mismatch");
      assertCatalogCertificate(base.certificate,options.signingCertificateSha256);
      const result = selected.length === 1
        ? await adbInstall(this.sdkRoot, serial, selected[0].file, { ...options, reinstall: options.reinstall ?? true })
        : await adbInstallMultiple(this.sdkRoot, serial, selected.map(p=>p.file), { ...options, reinstall: options.reinstall ?? true });
      return {success:result.success,packageName:base.packageName,versionName:base.versionName,versionCode:base.versionCode,durationMs:Date.now()-start,message:result.success?`Installed ${base.packageName}`:`${result.stderr || result.stdout}. Check missing feature splits, signing identity, storage and Android API. Play licensing, Integrity and hardware requirements cannot be bypassed.`};
    } finally { await fs.promises.rm(staging,{recursive:true,force:true}); }
  }

  async installApkFromUrl(url: string, fileName: string, sha256?: string, packageIdentity?: string, signingCertificateSha256?: string): Promise<InstallResult> {
    const dir = await fs.promises.mkdtemp(path.join(app.getPath("temp"), "aem-download-"));
    try {
      const safeName = path.basename(fileName).replace(/[^A-Za-z0-9._-]/g,"_");
      if (!/\.(apk|apks|xapk|apkm)$/i.test(safeName)) throw new Error("Unsupported package extension");
      const file = path.join(dir,safeName);
      await downloadVerified(url,file,sha256);
      return await this.installApk(file,{packageIdentity,signingCertificateSha256});
    } finally { await fs.promises.rm(dir,{recursive:true,force:true}); }
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
      const metadata = await inspectApk(filePath, this.sdkRoot);
      Object.assign(info, metadata, { valid: true });
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
