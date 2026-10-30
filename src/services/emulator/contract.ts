/**
 * Emulator bridge contract — shared between renderer and preload.
 * Renderer should never import Electron directly; it checks window.aemDesktop.
 */

export type EmulatorState = "not-installed" | "installing" | "ready" | "starting" | "running" | "stopping" | "error" | "unavailable";

export interface EmulatorStatus {
  state: EmulatorState;
  avdName: string | null;
  pid: number | null;
  adbSerial: string | null;
  uptimeMs: number | null;
  bootCompleted: boolean;
  lastError: string | null;
  progress?: { phase: string; percent: number; message: string };
  version?: { emulator: string; adb: string; apiLevel: number };
}

export interface DiagnosticsResult {
  timestamp: string;
  platform: string;
  arch: string;
  checks: { id: string; label: string; status: "pass"|"warn"|"fail"|"info"; message: string; details?: string; fix?: string; required: boolean }[];
  summary: { passed: number; warnings: number; failed: number; canRun: boolean };
  requirements: { minRamMB: number; recommendedRamMB: number; minDiskMB: number; recommendedDiskMB: number; minCpuCores: number };
  host: { totalMemMB: number; freeMemMB: number; cpuModel: string; cpuCores: number; gpuInfo?: string; osVersion: string; virtualizationEnabled?: boolean; hypervisor?: string; diskFreeMB?: number };
}

export interface SdkStatus {
  installed: boolean;
  sdkRoot: string;
  components: {
    platformTools: { installed: boolean; path: string | null; version?: string };
    emulator: { installed: boolean; path: string | null; version?: string };
    cmdlineTools: { installed: boolean; path: string | null };
    systemImage: { installed: boolean; apiLevel: number; variant: string; path: string | null };
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
  gpuMode: string;
  snapshotEnabled: boolean;
  createdAt?: string;
}

export interface InstalledApp {
  packageName: string;
  label: string;
  versionName: string;
  versionCode: number;
  systemApp: boolean;
  enabled: boolean;
}

export interface EmulatorBridge {
  getStatus(): Promise<EmulatorStatus>;
  getDiagnostics(force?: boolean): Promise<DiagnosticsResult>;
  getSdkStatus(): Promise<SdkStatus>;
  installSdk(): Promise<SdkStatus>;
  onSdkProgress(cb: (p: { phase: string; percent: number; message: string }) => void): () => void;
  listAvds(): Promise<AvdInfo[]>;
  getAvdInfo(name: string): Promise<AvdInfo | null>;
  listSystemImages(): Promise<any[]>;
  createAvd(opts: any): Promise<AvdInfo>;
  deleteAvd(name: string): Promise<boolean>;
  wipeAvd(name: string): Promise<void>;
  updateAvd(name: string, patch: any): Promise<AvdInfo | null>;
  start(opts?: any): Promise<EmulatorStatus>;
  stop(): Promise<EmulatorStatus>;
  restart(opts?: any): Promise<EmulatorStatus>;
  getInstalledApps(): Promise<InstalledApp[]>;
  installApk(filePath: string, opts?: any): Promise<{ success: boolean; message: string; packageName?: string }>;
  installApkFromUrl(url: string, fileName: string): Promise<{ success: boolean; message: string }>;
  uninstallApp(pkg: string, keepData?: boolean): Promise<{ success: boolean; message: string }>;
  launchApp(pkg: string, activity?: string): Promise<{ success: boolean; message: string }>;
  getAppInfo(pkg: string): Promise<any>;
  getAppPermissions(pkg: string): Promise<{ requested: string[]; granted: string[] }>;
  grantPermission(pkg: string, perm: string): Promise<boolean>;
  revokePermission(pkg: string, perm: string): Promise<boolean>;
  clearAppData(pkg: string): Promise<boolean>;
  forceStop(pkg: string): Promise<boolean>;
  pushFile(localPath: string, remotePath: string): Promise<boolean>;
  pullFile(remotePath: string, localPath: string): Promise<boolean>;
  shell(cmd: string): Promise<string>;
  getApkInfo(filePath: string): Promise<any>;
  takeScreenshot(): Promise<{ success: boolean; dataBase64?: string; error?: string }>;
  setLocation(lat: number, lng: number): Promise<boolean>;
  rotate(r: number): Promise<boolean>;
  getLogs(limit?: number): Promise<string[]>;
  installStoreArtifact(artifact: { url: string; filename: string; packageIdentity?: string }): Promise<{ success: boolean; message: string }>;
}

export interface DesktopBridge {
  isDesktop: boolean;
  platform: NodeJS.Platform;
  arch: string;
  versions: { app: string; electron: string; chrome: string; node: string };
  openExternal(url: string): Promise<boolean>;
  showItemInFolder(path: string): Promise<boolean>;
  getAppPath(name: string): Promise<string>;
  getVersion(): Promise<string>;
  checkForUpdates(): Promise<{ available: boolean; latest?: string; current?: string; url?: string; error?: string }>;
  onMenuAction(cb: (action: string) => void): () => void;
  onOpenApkFile(cb: (filePath: string) => void): () => void;
  pickApkFile(): Promise<{ canceled: boolean; filePaths: string[] }>;
  pickFile(opts: { title?: string; filters?: { name: string; extensions: string[] }[] }): Promise<{ canceled: boolean; filePaths: string[] }>;
  emulator: EmulatorBridge;
}

declare global {
  interface Window {
    aemDesktop?: DesktopBridge;
    electron?: DesktopBridge;
    AEM_IS_DESKTOP?: boolean;
  }
}

export function isDesktop(): boolean {
  return typeof window !== "undefined" && (!!window.aemDesktop || !!window.AEM_IS_DESKTOP || (window as any).electron?.isDesktop);
}

export function getDesktop(): DesktopBridge | null {
  if (typeof window === "undefined") return null;
  return window.aemDesktop || (window as any).electron || null;
}
