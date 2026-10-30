/** Shared emulator types — used by both main and renderer via preload bridge */

export type EmulatorState = "not-installed" | "installing" | "ready" | "starting" | "running" | "stopping" | "error" | "unavailable";
export type EmulatorBootMode = "quick" | "cold" | "snapshot";
export type GpuMode = "auto" | "host" | "swiftshader_indirect" | "angle" | "off";
export type NetworkMode = "nat" | "none";

export interface EmulatorStatus {
  state: EmulatorState;
  avdName: string | null;
  pid: number | null;
  adbSerial: string | null; // e.g. emulator-5554
  uptimeMs: number | null;
  bootCompleted: boolean;
  lastError: string | null;
  progress?: { phase: string; percent: number; message: string };
  version?: { emulator: string; adb: string; apiLevel: number };
}

export interface DiagnosticsResult {
  timestamp: string;
  platform: NodeJS.Platform;
  arch: string;
  checks: DiagnosticCheck[];
  summary: { passed: number; warnings: number; failed: number; canRun: boolean };
  requirements: HostRequirements;
  host: HostInfo;
}

export interface DiagnosticCheck {
  id: string;
  label: string;
  status: "pass" | "warn" | "fail" | "info";
  message: string;
  details?: string;
  fix?: string;
  required: boolean;
}

export interface HostRequirements {
  minRamMB: number;
  recommendedRamMB: number;
  minDiskMB: number;
  recommendedDiskMB: number;
  minCpuCores: number;
  virtualizationRequired: boolean;
  hyperVModes: string[]; // WHPX, HAXM, Hyper-V
  supportedGpuModes: GpuMode[];
}

export interface HostInfo {
  totalMemMB: number;
  freeMemMB: number;
  cpuModel: string;
  cpuCores: number;
  gpuInfo?: string;
  osVersion: string;
  virtualizationEnabled?: boolean;
  hypervisor?: string;
  diskFreeMB?: number;
}

export interface SdkStatus {
  installed: boolean;
  sdkRoot: string;
  components: {
    platformTools: { installed: boolean; path: string | null; version?: string };
    emulator: { installed: boolean; path: string | null; version?: string };
    cmdlineTools: { installed: boolean; path: string | null };
    systemImage: { installed: boolean; apiLevel: number; variant: string; path: string | null };
    buildTools?: { installed: boolean; path: string | null };
  };
  needsInstall: string[];
  totalDownloadMB: number;
}

export interface AvdInfo {
  name: string;
  path: string;
  apiLevel: number;
  systemImage: string;
  device: string;
  ramMB: number;
  heapMB: number;
  storageMB: number;
  cores: number;
  gpuMode: GpuMode;
  snapshotEnabled: boolean;
  createdAt?: string;
  lastBootedAt?: string;
  sdCardMB?: number;
}

export interface AvdCreateOptions {
  name: string;
  systemImage: string; // e.g. system-images;android-34;google_apis;x86_64
  device?: string; // hardware profile id, e.g. pixel_7
  ramMB?: number;
  heapMB?: number;
  storageMB?: number;
  cores?: number;
  gpuMode?: GpuMode;
  sdCardMB?: number;
  snapshot?: boolean;
  keyboard?: boolean;
  skinName?: string;
}

export interface InstalledApp {
  packageName: string;
  label: string;
  versionName: string;
  versionCode: number;
  systemApp: boolean;
  enabled: boolean;
  firstInstallTime?: string;
  lastUpdateTime?: string;
  dataSizeMB?: number;
  permissions?: string[];
  grantedPermissions?: string[];
  iconBase64?: string | null;
}

export interface ApkInfo {
  fileName: string;
  filePath: string;
  fileSizeMB: number;
  packageName?: string;
  versionName?: string;
  versionCode?: number;
  minSdk?: number;
  targetSdk?: number;
  permissions?: string[];
  debuggable?: boolean;
  sha256?: string;
  valid: boolean;
  error?: string;
}

export interface EmulatorLaunchOptions {
  avdName?: string;
  bootMode?: EmulatorBootMode;
  gpuMode?: GpuMode;
  ramMB?: number;
  cores?: number;
  wipeData?: boolean;
  noWindow?: boolean;
  extraArgs?: string[];
  snapshotName?: string;
}

export interface AdbResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface InstallResult {
  success: boolean;
  packageName?: string;
  versionName?: string;
  versionCode?: number;
  alreadyInstalled?: boolean;
  downgraded?: boolean;
  message: string;
  durationMs: number;
}

export interface SystemImageInfo {
  id: string; // e.g. system-images;android-34;google_apis;x86_64
  apiLevel: number;
  variant: string; // google_apis, google_apis_playstore, default, etc.
  abi: string; // x86_64, arm64-v8a
  tag: string;
  description: string;
  downloadSizeMB: number;
  installed: boolean;
}

export interface EmulatorLogEntry {
  timestamp: string;
  level: "info" | "warn" | "error" | "debug";
  source: "emulator" | "adb" | "sdk" | "avd" | "system";
  message: string;
}

export interface FileTransferOptions {
  localPath: string;
  remotePath: string;
  createDirs?: boolean;
}

export interface ScreenshotResult {
  success: boolean;
  dataBase64?: string;
  filePath?: string;
  width?: number;
  height?: number;
  error?: string;
}
