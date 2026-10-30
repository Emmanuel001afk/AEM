import { contextBridge, ipcRenderer } from "electron";

// Expose a safe, versioned API to the renderer.
// This is the only bridge between Node/Electron and the web UI.
const api = {
  isDesktop: true as const,
  platform: process.platform as NodeJS.Platform,
  arch: process.arch,
  versions: {
    app: process.env.npm_package_version || "0.1.0",
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },

  // System
  openExternal: (url: string) => ipcRenderer.invoke("aem:openExternal", url),
  showItemInFolder: (filePath: string) => ipcRenderer.invoke("aem:showItemInFolder", filePath),
  getAppPath: (name: string) => ipcRenderer.invoke("aem:getAppPath", name),
  getVersion: () => ipcRenderer.invoke("aem:getVersion"),
  checkForUpdates: () => ipcRenderer.invoke("aem:checkForUpdates"),
  onMenuAction: (cb: (action: string) => void) => {
    const h = (_: any, action: string) => cb(action);
    ipcRenderer.on("aem:menuAction", h);
    return () => ipcRenderer.removeListener("aem:menuAction", h);
  },
  onOpenApkFile: (cb: (filePath: string) => void) => {
    const h = (_: any, filePath: string) => cb(filePath);
    ipcRenderer.on("aem:openApkFile", h);
    return () => ipcRenderer.removeListener("aem:openApkFile", h);
  },
  pickApkFile: (): Promise<{ canceled: boolean; filePaths: string[] }> => ipcRenderer.invoke("aem:pickApkFile"),
  pickFile: (opts: { title?: string; filters?: { name: string; extensions: string[] }[] }): Promise<{ canceled: boolean; filePaths: string[] }> =>
    ipcRenderer.invoke("aem:pickFile", opts),
  saveFile: (opts: { title?: string; defaultPath?: string; filters?: any[] }) => ipcRenderer.invoke("aem:saveFile", opts),

  // Emulator
  emulator: {
    getStatus: () => ipcRenderer.invoke("emulator:getStatus"),
    getDiagnostics: (force?: boolean) => ipcRenderer.invoke("emulator:getDiagnostics", force),
    getSdkStatus: () => ipcRenderer.invoke("emulator:getSdkStatus"),
    installSdk: () => ipcRenderer.invoke("emulator:installSdk"),
    onSdkProgress: (cb: (p: { phase: string; percent: number; message: string }) => void) => {
      const h = (_: any, p: any) => cb(p);
      ipcRenderer.on("emulator:sdkProgress", h);
      return () => ipcRenderer.removeListener("emulator:sdkProgress", h);
    },
    listAvds: () => ipcRenderer.invoke("emulator:listAvds"),
    getAvdInfo: (name: string) => ipcRenderer.invoke("emulator:getAvdInfo", name),
    listSystemImages: () => ipcRenderer.invoke("emulator:listSystemImages"),
    createAvd: (opts: any) => ipcRenderer.invoke("emulator:createAvd", opts),
    deleteAvd: (name: string) => ipcRenderer.invoke("emulator:deleteAvd", name),
    wipeAvd: (name: string) => ipcRenderer.invoke("emulator:wipeAvd", name),
    updateAvd: (name: string, patch: any) => ipcRenderer.invoke("emulator:updateAvd", name, patch),

    start: (opts?: any) => ipcRenderer.invoke("emulator:start", opts),
    stop: () => ipcRenderer.invoke("emulator:stop"),
    restart: (opts?: any) => ipcRenderer.invoke("emulator:restart", opts),

    getInstalledApps: () => ipcRenderer.invoke("emulator:getInstalledApps"),
    installApk: (filePath: string, opts?: any) => ipcRenderer.invoke("emulator:installApk", filePath, opts),
    installApkFromUrl: (url: string, fileName: string) => ipcRenderer.invoke("emulator:installApkFromUrl", url, fileName),
    uninstallApp: (pkg: string, keepData?: boolean) => ipcRenderer.invoke("emulator:uninstallApp", pkg, keepData),
    launchApp: (pkg: string, activity?: string) => ipcRenderer.invoke("emulator:launchApp", pkg, activity),
    getAppInfo: (pkg: string) => ipcRenderer.invoke("emulator:getAppInfo", pkg),
    getAppPermissions: (pkg: string) => ipcRenderer.invoke("emulator:getAppPermissions", pkg),
    grantPermission: (pkg: string, perm: string) => ipcRenderer.invoke("emulator:grantPermission", pkg, perm),
    revokePermission: (pkg: string, perm: string) => ipcRenderer.invoke("emulator:revokePermission", pkg, perm),
    clearAppData: (pkg: string) => ipcRenderer.invoke("emulator:clearAppData", pkg),
    forceStop: (pkg: string) => ipcRenderer.invoke("emulator:forceStop", pkg),

    pushFile: (localPath: string, remotePath: string) => ipcRenderer.invoke("emulator:pushFile", localPath, remotePath),
    pullFile: (remotePath: string, localPath: string) => ipcRenderer.invoke("emulator:pullFile", remotePath, localPath),
    shell: (cmd: string) => ipcRenderer.invoke("emulator:shell", cmd),
    getApkInfo: (filePath: string) => ipcRenderer.invoke("emulator:getApkInfo", filePath),
    takeScreenshot: () => ipcRenderer.invoke("emulator:takeScreenshot"),
    setLocation: (lat: number, lng: number) => ipcRenderer.invoke("emulator:setLocation", lat, lng),
    rotate: (r: number) => ipcRenderer.invoke("emulator:rotate", r),

    getLogs: (limit?: number) => ipcRenderer.invoke("emulator:getLogs", limit),

    // Store integration: install latest artifact from AEM catalog directly to emulator
    installStoreArtifact: (artifact: { url: string; filename: string; packageIdentity?: string }) =>
      ipcRenderer.invoke("emulator:installStoreArtifact", artifact),
  },
};

contextBridge.exposeInMainWorld("aemDesktop", api);

// Also legacy name for compatibility
contextBridge.exposeInMainWorld("electron", api);

declare global {
  interface Window {
    aemDesktop: typeof api;
    electron: typeof api;
  }
}

// Keep renderer isolated
contextBridge.exposeInMainWorld("AEM_IS_DESKTOP", true);
