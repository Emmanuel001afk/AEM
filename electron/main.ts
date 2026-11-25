import { app, BrowserWindow, Menu, shell, dialog } from "electron";
import path from "path";
import fs from "fs";
import { stopPhone } from "./phone-runtime";
import { isAllowedExternal, isTrustedRenderer } from "./security";
import { registerIpc, stopTransferServices } from "./ipc";
import { EmulatorManager } from "./emulator/manager";

// ─── App identity & single instance ───
const APP_ID = "com.aem.store";
if (process.platform === "win32") app.setAppUserModelId(APP_ID);

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // ─── Globals ───
  let mainWindow: BrowserWindow | null = null;
  let pendingApkFile: string | null = null;
  let quitting = false;

  const isDev = (): boolean => !app.isPackaged;

  const getRendererUrl = (): string => {
    if (isDev() && process.env.AEM_DEV_URL) return process.env.AEM_DEV_URL;
    return `file://${path.join(__dirname, "../dist/index.html")}`;
  };

  const getIconPath = (): string => {
    if (app.isPackaged) {
      const res = path.join(process.resourcesPath, "icons", "icon.png");
      if (fs.existsSync(res)) return res;
      const ico = path.join(process.resourcesPath, "icons", "icon.ico");
      if (fs.existsSync(ico)) return ico;
    }
    const localIco = path.join(__dirname, "../resources/icons/icon.ico");
    if (fs.existsSync(localIco)) return localIco;
    const localPng = path.join(__dirname, "../resources/icons/icon.png");
    if (fs.existsSync(localPng)) return localPng;
    return "";
  };

  const cleanStaleNativeTemp = async () => {
    try {
      const tmpRoot = app.getPath("temp");
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      for (const entry of await fs.promises.readdir(tmpRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith("native-install-")) continue;
        const full = path.join(tmpRoot, entry.name);
        const st = await fs.promises.stat(full).catch(() => null);
        if (st && st.mtimeMs < cutoff) {
          await fs.promises.rm(full, { recursive: true, force: true }).catch(() => {});
        }
      }
    } catch {}
  };

  const createMenu = () => {
    const template: any[] = [
      {
        label: "File",
        submenu: [
          {
            label: "Open APK…",
            accelerator: "CmdOrCtrl+O",
            click: async () => {
              if (!mainWindow || mainWindow.isDestroyed()) return;
              const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
                title: "Open Android Package",
                filters: [
                  { name: "Android Packages", extensions: ["apk", "apks", "xapk", "apkm", "zip"] },
                  { name: "All Files", extensions: ["*"] },
                ],
                properties: ["openFile"],
              });
              if (!canceled && filePaths[0]) mainWindow.webContents.send("aem:openApkFile", filePaths[0]);
            },
          },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      {
        label: "Edit",
        submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }],
      },
      {
        label: "View",
        submenu: [
          { role: "reload" },
          { role: "forceReload" },
          { role: "toggleDevTools" },
          { type: "separator" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { type: "separator" },
          { role: "togglefullscreen" },
        ],
      },
      {
        label: "Emulator",
        submenu: [
          { label: "Start Emulator", click: () => mainWindow?.webContents.send("aem:menuAction", "emulator:start") },
          { label: "Stop Emulator", click: () => mainWindow?.webContents.send("aem:menuAction", "emulator:stop") },
          { label: "Restart Emulator", click: () => mainWindow?.webContents.send("aem:menuAction", "emulator:restart") },
          { type: "separator" },
          { label: "Install APK…", click: () => mainWindow?.webContents.send("aem:menuAction", "emulator:installApk") },
          { label: "Take Screenshot", click: () => mainWindow?.webContents.send("aem:menuAction", "emulator:screenshot") },
          { type: "separator" },
          { label: "Show Logs", click: () => mainWindow?.webContents.send("aem:menuAction", "emulator:logs") },
        ],
      },
      {
        label: "Transfer",
        submenu: [
          { label: "AEM PC ↔ PC transfer", click: () => mainWindow?.webContents.send("aem:menuAction", "peer:open") },
          { label: "Open received files folder", click: () => mainWindow?.webContents.send("aem:menuAction", "peer:folder") },
        ],
      },
      {
        label: "Help",
        submenu: [
          { label: "About AEM Store", click: () => shell.openExternal("https://github.com/Emmanuel001afk/AEM") },
          { label: "Documentation", click: () => shell.openExternal("https://github.com/Emmanuel001afk/AEM#readme") },
          { type: "separator" },
          { label: `Version ${app.getVersion()}`, enabled: false },
        ],
      },
    ];
    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
  };

  const createWindow = async (): Promise<BrowserWindow> => {
    process.env.npm_package_version ||= app.getVersion();
    const iconPath = getIconPath();
    const win = new BrowserWindow({
      width: 1280,
      height: 860,
      minWidth: 1024,
      minHeight: 680,
      backgroundColor: "#09090c",
      title: "AEM Store",
      icon: iconPath || undefined,
      show: false,
      autoHideMenuBar: false,
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
      },
      titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    });

    win.webContents.setWindowOpenHandler(({ url }) => {
      if (isAllowedExternal(url)) void shell.openExternal(url);
      return { action: "deny" };
    });

    registerIpc(win);

    win.once("ready-to-show", () => {
      win.show();
      win.focus();
      if (pendingApkFile) {
        win.webContents.send("aem:openApkFile", pendingApkFile);
        pendingApkFile = null;
      }
    });

    win.on("closed", () => {
      if (mainWindow === win) mainWindow = null;
    });

    win.webContents.on("will-navigate", (event, url) => {
      if (!isTrustedRenderer(url, path.join(__dirname, "../dist/index.html"), isDev() ? process.env.AEM_DEV_URL : undefined)) event.preventDefault();
    });
    win.webContents.on("will-attach-webview", event => event.preventDefault());
    win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));

    mainWindow = win;
    const url = getRendererUrl();
    if (url.startsWith("file://")) {
      await win.loadFile(path.join(__dirname, "../dist/index.html"));
    } else {
      await win.loadURL(url);
    }

    if (process.env.AEM_SMOKE_TEST === "1" && process.env.AEM_SMOKE_RESULT) {
      const ok = await win.webContents.executeJavaScript(`new Promise(resolve => {
        const deadline = Date.now() + 10000;
        const check = () => {
          if (document.querySelector('#root')?.childElementCount && window.aemDesktop?.isDesktop) return resolve(true);
          if (Date.now() > deadline) return resolve(false);
          setTimeout(check, 100);
        }; check();
      })`);
      fs.writeFileSync(process.env.AEM_SMOKE_RESULT, JSON.stringify({ ok, version: app.getVersion(), executable: process.execPath, userData: app.getPath("userData") }));
      app.quit();
    }

    win.webContents.on("render-process-gone", (_e, details) => {
      console.error(`Renderer gone: ${details.reason}`);
    });

    return win;
  };

  const handleArgv = (argv: string[]) => {
    const apk = argv.find(a => /\.(apk|apks|xapk|apkm|zip)$/i.test(a));
    if (apk) {
      pendingApkFile = apk;
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("aem:openApkFile", apk);
    }
  };

  app.on("second-instance", (_e, argv) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    handleArgv(argv);
  });

  app.on("open-file", (e, filePath) => {
    e.preventDefault();
    if (/\.(apk|apks|xapk|apkm|zip)$/i.test(filePath)) {
      pendingApkFile = filePath;
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("aem:openApkFile", filePath);
    }
  });

  app.on("will-finish-launching", () => {
    handleArgv(process.argv);
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });

  app.whenReady().then(async () => {
    createMenu();
    void cleanStaleNativeTemp();
    await createWindow();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    stopPhone();
    const stop = async () => {
      await stopTransferServices().catch(console.error);
      const mgr = EmulatorManager.getInstance();
      const status = await mgr.getStatus();
      if (["running", "starting", "stopping"].includes(status.state)) await mgr.stop();
    };
    void Promise.race([stop().catch(console.error), new Promise(resolve => setTimeout(resolve, 8000))]).finally(() => app.quit());
  });
}

process.on("uncaughtException", err => console.error("Uncaught", err));
process.on("unhandledRejection", err => console.error("Unhandled", err));
