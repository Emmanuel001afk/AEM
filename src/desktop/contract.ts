export interface AndroidSettings { cores: number; memoryMB: number; diskGB: number; gpu: "auto" | "host" | "software"; camera: "off" | "webcam0"; microphone: boolean }
export interface AndroidState {
  phase: "idle" | "setup" | "starting" | "running" | "stopping" | "error";
  installed: boolean; ready: boolean; settings: AndroidSettings; task?: string | null;
  setup: { step: string; percent: number; detail: string } | null;
  serial: string | null; lastError: string | null; bootSeconds: number | null; logs: string[];
  transfer?: { kind: "download"; filename: string; bytes: number; total: number } | null;
  paths: { sdk: string; avd: string; logs: string };
}
export interface AndroidApp { packageName: string; versionName: string; versionCode: number; enabled: boolean }
export interface ApkMetadata { packageName: string; label: string; versionName: string; versionCode: number; minSdk: number; targetSdk?: number; signingCertificateSha256: string; sizeBytes: number; armOnly: boolean }
export interface AndroidPermission { name: string; granted: boolean; manageable: boolean }
export interface RuntimeDiagnostics {
  host: { os: string; cpu: string; cores: number; totalMemoryMB: number; freeMemoryMB: number; freeDiskGB: number | null; supported: boolean };
  virtualization: string | null;
  acceleration: { available: boolean; output: string };
  cameras: string[];
  checks: { id: string; label: string; status: "pass" | "warn" | "fail"; detail: string }[];
  state: AndroidState;
}
export interface CatalogApk { url: string; filename: string; sha256: string; sizeBytes?: number; packageIdentity: string; signingCertificateSha256?: string; versionCode: number }
export interface DesktopBridge {
  getState(): Promise<AndroidState>;
  getDiagnostics(): Promise<RuntimeDiagnostics>;
  configure(settings: Partial<AndroidSettings>): Promise<AndroidState>;
  setup(consent: { acceptLicenses: boolean }): Promise<AndroidState>;
  start(): Promise<AndroidState>;
  stop(): Promise<AndroidState>;
  listApps(): Promise<AndroidApp[]>;
  launchApp(pkg: string): Promise<{ launched: boolean }>;
  uninstallApp(pkg: string): Promise<{ removed?: boolean; cancelled?: boolean }>;
  clearAppData(pkg: string): Promise<{ cleared?: boolean; cancelled?: boolean }>;
  getPermissions(pkg: string): Promise<AndroidPermission[]>;
  setPermission(pkg: string, permission: string, granted: boolean): Promise<AndroidPermission[]>;
  openAndroidSettings(pkg?: string): Promise<{ opened: boolean }>;
  chooseApk(): Promise<{ token: string; filename: string; metadata: ApkMetadata } | null>;
  installSelectedApk(token: string): Promise<ApkMetadata>;
  installCatalogApk(artifact: CatalogApk): Promise<ApkMetadata>;
  chooseFile(): Promise<{ token: string; filename: string; sizeBytes: number } | null>;
  pushFile(token: string): Promise<{ remotePath: string; sizeBytes: number }>;
  listFiles(): Promise<string[]>;
  pullFile(remote: string): Promise<{ saved?: boolean; cancelled?: boolean }>;
  getStorage(): Promise<string>;
  reversePort(port: number): Promise<{ port: number }>;
  resetDevice(): Promise<{ cancelled?: boolean }>;
  openLogs(): Promise<{ opened: boolean }>;
  exportDiagnostics(): Promise<{ saved?: boolean; cancelled?: boolean }>;
  getAppInfo(): Promise<{ version: string; platform: string; arch: string; packaged: boolean }>;
  checkForUpdates(): Promise<{ available: boolean; message: string }>;
  openExternal(url: string): Promise<void>;
  onState(listener: (state: AndroidState) => void): () => void;
  onOpenAndroid(listener: () => void): () => void;
}
declare global { interface Window { aemDesktop?: DesktopBridge } }
