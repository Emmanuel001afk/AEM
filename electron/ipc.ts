import { ipcMain, dialog, shell, app, BrowserWindow } from "electron";
import path from "path";
import { EmulatorManager } from "./emulator/manager";

export function registerIpc(mainWindow: BrowserWindow) {
  const emu = EmulatorManager.getInstance();

  // System
  ipcMain.handle("aem:openExternal", async (_e, url: string) => {
    await shell.openExternal(url);
    return true;
  });
  ipcMain.handle("aem:showItemInFolder", async (_e, filePath: string) => {
    shell.showItemInFolder(filePath);
    return true;
  });
  ipcMain.handle("aem:getAppPath", async (_e, name: string) => {
    try { return app.getPath(name as any); } catch { return app.getPath("userData"); }
  });
  ipcMain.handle("aem:getVersion", async () => app.getVersion());
  ipcMain.handle("aem:checkForUpdates", async () => {
    // Simple GitHub releases check
    try {
      const https = await import("https");
      const data: any = await new Promise((resolve, reject) => {
        https.get("https://api.github.com/repos/Emmanuel001afk/AEM/releases/latest", {
          headers: { "User-Agent": "AEM-Store", Accept: "application/vnd.github+json" }
        }, res => {
          let body = "";
          res.on("data", d => body += d);
          res.on("end", () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
        }).on("error", reject);
      });
      if (!data) return { available: false };
      const latest = String(data.tag_name || data.name || "");
      const current = app.getVersion();
      return { available: latest !== current && latest !== `v${current}`, latest, current, url: data.html_url };
    } catch (e: any) {
      return { available: false, error: e.message };
    }
  });

  ipcMain.handle("aem:pickApkFile", async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: "Select Android APK",
      filters: [
        { name: "Android Packages", extensions: ["apk", "apks", "xapk", "apkm", "zip"] },
        { name: "All Files", extensions: ["*"] },
      ],
      properties: ["openFile", "multiSelections"],
    });
    return { canceled: r.canceled, filePaths: r.filePaths };
  });

  ipcMain.handle("aem:pickFile", async (_e, opts: any) => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: opts?.title || "Select File",
      filters: opts?.filters || [{ name: "All Files", extensions: ["*"] }],
      properties: ["openFile", "multiSelections"],
    });
    return { canceled: r.canceled, filePaths: r.filePaths };
  });

  ipcMain.handle("aem:saveFile", async (_e, opts: any) => {
    const r = await dialog.showSaveDialog(mainWindow, {
      title: opts?.title || "Save File",
      defaultPath: opts?.defaultPath,
      filters: opts?.filters,
    });
    return { canceled: r.canceled, filePath: r.filePath };
  });

  // Emulator
  ipcMain.handle("emulator:getStatus", async () => emu.getStatus());
  ipcMain.handle("emulator:getDiagnostics", async (_e, force?: boolean) => emu.getDiagnostics(!!force));
  ipcMain.handle("emulator:getSdkStatus", async () => emu.getSdkStatus());
  ipcMain.handle("emulator:installSdk", async () => {
    return emu.installSdk(p => {
      try { mainWindow.webContents.send("emulator:sdkProgress", p); } catch {}
    });
  });
  ipcMain.handle("emulator:listAvds", async () => emu.listAvds());
  ipcMain.handle("emulator:getAvdInfo", async (_e, name: string) => emu.getAvdInfo(name));
  ipcMain.handle("emulator:listSystemImages", async () => emu.listSystemImages());
  ipcMain.handle("emulator:createAvd", async (_e, opts: any) => emu.createAvd(opts));
  ipcMain.handle("emulator:deleteAvd", async (_e, name: string) => emu.deleteAvd(name));
  ipcMain.handle("emulator:wipeAvd", async (_e, name: string) => emu.wipeAvd(name));
  ipcMain.handle("emulator:updateAvd", async (_e, name: string, patch: any) => emu.updateAvd(name, patch));

  ipcMain.handle("emulator:start", async (_e, opts: any) => emu.start(opts));
  ipcMain.handle("emulator:stop", async () => emu.stop());
  ipcMain.handle("emulator:restart", async (_e, opts: any) => emu.restart(opts));

  ipcMain.handle("emulator:getInstalledApps", async () => emu.getInstalledApps());
  ipcMain.handle("emulator:installApk", async (_e, filePath: string, opts: any) => emu.installApk(filePath, opts));
  ipcMain.handle("emulator:installApkFromUrl", async (_e, url: string, fileName: string) => emu.installApkFromUrl(url, fileName));
  ipcMain.handle("emulator:uninstallApp", async (_e, pkg: string, keepData?: boolean) => emu.uninstallApp(pkg, !!keepData));
  ipcMain.handle("emulator:launchApp", async (_e, pkg: string, activity?: string) => emu.launchApp(pkg, activity));
  ipcMain.handle("emulator:getAppInfo", async (_e, pkg: string) => emu.getAppInfo(pkg));
  ipcMain.handle("emulator:getAppPermissions", async (_e, pkg: string) => emu.getAppPermissions(pkg));
  ipcMain.handle("emulator:grantPermission", async (_e, pkg: string, perm: string) => emu.grantPermission(pkg, perm));
  ipcMain.handle("emulator:revokePermission", async (_e, pkg: string, perm: string) => emu.revokePermission(pkg, perm));
  ipcMain.handle("emulator:clearAppData", async (_e, pkg: string) => emu.clearAppData(pkg));
  ipcMain.handle("emulator:forceStop", async (_e, pkg: string) => emu.forceStop(pkg));

  ipcMain.handle("emulator:pushFile", async (_e, localPath: string, remotePath: string) => emu.pushFile(localPath, remotePath));
  ipcMain.handle("emulator:pullFile", async (_e, remotePath: string, localPath: string) => emu.pullFile(remotePath, localPath));
  ipcMain.handle("emulator:shell", async (_e, cmd: string) => emu.shell(cmd));
  ipcMain.handle("emulator:getApkInfo", async (_e, filePath: string) => emu.getApkInfo(filePath));
  ipcMain.handle("emulator:takeScreenshot", async () => emu.takeScreenshot());
  ipcMain.handle("emulator:setLocation", async (_e, lat: number, lng: number) => emu.setLocation(lat, lng));
  ipcMain.handle("emulator:rotate", async (_e, r: number) => emu.rotate(r as any));

  ipcMain.handle("emulator:getLogs", async (_e, limit?: number) => emu.getLogs(limit));

  ipcMain.handle("emulator:installStoreArtifact", async (_e, artifact: { url: string; filename: string }) => {
    return emu.installApkFromUrl(artifact.url, artifact.filename);
  });
}
