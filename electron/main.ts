import { app, BrowserWindow, Menu, shell, dialog, nativeImage } from "electron";
import path from "path";
import fs from "fs";
import { stopPhone } from "./phone-runtime";
import { isAllowedExternal, isTrustedRenderer } from "./security";
import { registerIpc } from "./ipc";
import { EmulatorManager } from "./emulator/manager";

// ─── App identity & single instance ───
const APP_ID = "com.aem.store";
if (process.platform === "win32") app.setAppUserModelId(APP_ID);

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

// ─── Globals ───
let mainWindow: BrowserWindow | null = null;
let pendingApkFile: string | null = null;

function isDev(): boolean {
  return !app.isPackaged;
}

function getRendererUrl(): string {
  if (isDev() && process.env.AEM_DEV_URL) return process.env.AEM_DEV_URL;
  return `file://${path.join(__dirname, "../dist/index.html")}`;
}

function getIconPath(): string {
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
}

function createMenu() {
  const template: any[] = [
    {
      label: "File",
      submenu: [
        {
          label: "Open APK…",
          accelerator: "CmdOrCtrl+O",
          click: async () => {
            if (!mainWindow) return;
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
}

async function createWindow(): Promise<BrowserWindow> {
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

  // Security: open external links in browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternal(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  // Register IPC before load
  registerIpc(win);

  win.once("ready-to-show", () => {
    win.show();
    win.focus();
    // If launched with APK file, forward it
    if (pendingApkFile) {
      win.webContents.send("aem:openApkFile", pendingApkFile);
      pendingApkFile = null;
    }
  });

  win.webContents.on("will-navigate", (event, url) => {
    if (!isTrustedRenderer(url, path.join(__dirname, "../dist/index.html"), isDev() ? process.env.AEM_DEV_URL : undefined)) event.preventDefault();
  });
  win.webContents.on("will-attach-webview", event => event.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));

  // Load renderer
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

  // Graceful handling of crashes
  win.webContents.on("render-process-gone", (_e, details) => {
    console.error(`Renderer gone: ${details.reason}`);
  });

  mainWindow = win;
  return win;
}

// ─── File associations & protocol ───
function handleArgv(argv: string[]) {
  const apk = argv.find(a => /\.(apk|apks|xapk|apkm|zip)$/i.test(a));
  if (apk) {
    pendingApkFile = apk;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("aem:openApkFile", apk);
  }
}

// Windows: second instance
app.on("second-instance", (_e, argv) => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
  handleArgv(argv);
});

// macOS/Linux: open-file
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

// ─── App lifecycle ───
app.whenReady().then(async () => {
  createMenu();
  await createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // ADB starts only for explicit emulator/device operations.

});

app.on("window-all-closed", () => {
  // Keep emulator running? Opt to stop emulator on quit
  if (process.platform !== "darwin") app.quit();
});

let quitting = false;
app.on("before-quit", (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  stopPhone();
  // preventDefault must happen synchronously, before an await yields to Electron.
  const stop = async () => {
    const mgr = EmulatorManager.getInstance();
    const status = await mgr.getStatus();
    if (["running","starting","stopping"].includes(status.state)) await mgr.stop();
  };
  void Promise.race([stop().catch(console.error),new Promise(resolve=>setTimeout(resolve,8000))]).finally(()=>app.quit());
});

// ─── Crash handling ───
process.on("uncaughtException", err => console.error("Uncaught", err));
process.on("unhandledRejection", err => console.error("Unhandled", err));
