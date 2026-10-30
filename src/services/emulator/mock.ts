/** Mock emulator for browser / dev without real SDK — provides UI parity and simulated flows */
import type { EmulatorStatus, DiagnosticsResult, SdkStatus, AvdInfo, InstalledApp } from "./contract";

let mockStatus: EmulatorStatus = {
  state: "not-installed",
  avdName: null,
  pid: null,
  adbSerial: null,
  uptimeMs: null,
  bootCompleted: false,
  lastError: null,
};

let mockApps: InstalledApp[] = [
  { packageName: "com.android.settings", label: "Settings", versionName: "14", versionCode: 34, systemApp: true, enabled: true },
];

let mockAvds: AvdInfo[] = [];

const mockSdk: SdkStatus = {
  installed: false,
  sdkRoot: "/mock/sdk",
  components: {
    platformTools: { installed: false, path: null },
    emulator: { installed: false, path: null },
    cmdlineTools: { installed: false, path: null },
    systemImage: { installed: false, apiLevel: 34, variant: "google_apis", path: null },
  },
  needsInstall: ["platform-tools", "emulator", "system-images;android-34;google_apis;x86_64"],
  totalDownloadMB: 1162,
};

const mockDiagnostics: DiagnosticsResult = {
  timestamp: new Date().toISOString(),
  platform: "linux",
  arch: "x64",
  summary: { passed: 2, warnings: 1, failed: 1, canRun: false },
  requirements: { minRamMB: 4096, recommendedRamMB: 8192, minDiskMB: 10240, recommendedDiskMB: 20480, minCpuCores: 4 },
  host: { totalMemMB: 3929, freeMemMB: 1200, cpuModel: "Mock CPU (CI)", cpuCores: 2, osVersion: "Linux 6.x mock", virtualizationEnabled: false, hypervisor: undefined, diskFreeMB: 8000 },
  checks: [
    { id: "virtualization", label: "CPU Virtualization", status: "fail", message: "Disabled in mock — enable VT-x/AMD-V in BIOS", fix: "Enable virtualization in BIOS", required: true },
    { id: "ram", label: "System Memory", status: "warn", message: "3929 MB total — below recommended 8192 MB", required: false },
    { id: "disk", label: "Disk Space", status: "fail", message: "7.8 GB free — need 10 GB", required: true },
    { id: "gpu", label: "Graphics Acceleration", status: "info", message: "Mock GPU — SwiftShader fallback", required: false },
  ],
};

export const mockEmulatorBridge = {
  async getStatus(): Promise<EmulatorStatus> { return { ...mockStatus }; },
  async getDiagnostics(): Promise<DiagnosticsResult> { return mockDiagnostics; },
  async getSdkStatus(): Promise<SdkStatus> { return mockSdk; },
  async installSdk(): Promise<SdkStatus> {
    mockStatus = { ...mockStatus, state: "installing", progress: { phase: "platform-tools", percent: 30, message: "Downloading (mock)…" } };
    await new Promise(r => setTimeout(r, 800));
    mockStatus = { ...mockStatus, state: "ready", lastError: null, progress: undefined };
    mockSdk.installed = true;
    mockAvds = [{ name: "aem_pixel_7", path: "/mock/avd", apiLevel: 34, systemImage: "system-images;android-34;google_apis;x86_64", device: "pixel_7", ramMB: 3072, heapMB: 512, storageMB: 8192, cores: 2, gpuMode: "auto", snapshotEnabled: true }];
    return mockSdk;
  },
  onSdkProgress() { return () => {}; },
  async listAvds(): Promise<AvdInfo[]> { return mockAvds; },
  async getAvdInfo(name: string): Promise<AvdInfo | null> { return mockAvds.find(a => a.name === name) || null; },
  async listSystemImages() { return [{ id: "system-images;android-34;google_apis;x86_64", apiLevel: 34, variant: "google_apis", abi: "x86_64", description: "Android 14 · Google APIs", downloadSizeMB: 900, installed: false }]; },
  async createAvd(opts: any): Promise<AvdInfo> {
    const avd: AvdInfo = { name: opts.name, path: `/mock/${opts.name}.avd`, apiLevel: 34, systemImage: opts.systemImage, device: opts.device || "pixel_7", ramMB: opts.ramMB || 3072, heapMB: 512, storageMB: opts.storageMB || 8192, cores: opts.cores || 4, gpuMode: opts.gpuMode || "auto", snapshotEnabled: true };
    mockAvds.push(avd);
    return avd;
  },
  async deleteAvd(name: string) { mockAvds = mockAvds.filter(a => a.name !== name); return true; },
  async wipeAvd() {},
  async updateAvd(name: string, patch: any) { const avd = mockAvds.find(a => a.name === name); if (avd) Object.assign(avd, patch); return avd || null; },
  async start(): Promise<EmulatorStatus> {
    mockStatus = { state: "starting", avdName: "aem_pixel_7", pid: 1234, adbSerial: "emulator-5554", uptimeMs: 0, bootCompleted: false, lastError: null, progress: { phase: "boot", percent: 40, message: "Mock booting…" } };
    await new Promise(r => setTimeout(r, 600));
    mockStatus = { state: "running", avdName: "aem_pixel_7", pid: 1234, adbSerial: "emulator-5554", uptimeMs: 1000, bootCompleted: true, lastError: null };
    return mockStatus;
  },
  async stop(): Promise<EmulatorStatus> { mockStatus = { state: "ready", avdName: "aem_pixel_7", pid: null, adbSerial: null, uptimeMs: null, bootCompleted: false, lastError: null }; return mockStatus; },
  async restart() { await mockEmulatorBridge.stop(); return mockEmulatorBridge.start(); },
  async getInstalledApps(): Promise<InstalledApp[]> { return [...mockApps]; },
  async installApk(filePath: string) {
    const pkg = `com.mock.${filePath.split("/").pop()?.replace(/[^a-z0-9]/gi, "_").slice(0, 20) || "test"}`;
    mockApps.push({ packageName: pkg, label: pkg.split(".").pop() || "MockApp", versionName: "1.0.0", versionCode: 1, systemApp: false, enabled: true });
    return { success: true, message: `Installed ${filePath} (mock)`, packageName: pkg };
  },
  async installApkFromUrl(url: string, fileName: string) { return mockEmulatorBridge.installApk(`/mock/${fileName}`); },
  async uninstallApp(pkg: string) { mockApps = mockApps.filter(a => a.packageName !== pkg); return { success: true, message: `Uninstalled ${pkg} (mock)` }; },
  async launchApp(pkg: string) { return { success: true, message: `Launched ${pkg} (mock)` }; },
  async getAppInfo(pkg: string) { return mockApps.find(a => a.packageName === pkg) || null; },
  async getAppPermissions() { return { requested: ["android.permission.INTERNET"], granted: ["android.permission.INTERNET"] }; },
  async grantPermission() { return true; },
  async revokePermission() { return true; },
  async clearAppData() { return true; },
  async forceStop() { return true; },
  async pushFile() { return true; },
  async pullFile() { return true; },
  async shell(cmd: string) { return `mock shell: ${cmd}`; },
  async getApkInfo(filePath: string) { return { fileName: filePath.split("/").pop(), filePath, fileSizeMB: 1.2, packageName: "com.mock.test", versionName: "1.0", versionCode: 1, valid: true }; },
  async takeScreenshot() { return { success: false, error: "Mock — no emulator screen" }; },
  async setLocation() { return true; },
  async rotate() { return true; },
  async getLogs() { return ["[mock] emulator log line", "[mock] system ready"]; },
  async installStoreArtifact(art: any) { return mockEmulatorBridge.installApkFromUrl(art.url, art.filename); },
};
