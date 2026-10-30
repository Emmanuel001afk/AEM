import { app, BrowserWindow, Menu, shell, dialog, nativeImage } from "electron";
import path from "path";
import fs from "fs";
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
  if (isDev()) return "http://localhost:5173";
  return `file://${path.join(__dirname, "../dist/index.html")}`;
}

function getIconPath(): string {
  if (app.isPackaged) {
    const res = path.join(process.resourcesPath, "icons", "icon.png");
    if (fs.existsSync(res)) return res;
    const ico = path.join(process.resourcesPath, "icons", "icon.ico");
    if (fs.existsSync(ico)) return ico;
  }
  const localIco = path.join(__dirname, "../../resources/icons/icon.ico");
  if (fs.existsSync(localIco)) return localIco;
  const localPng = path.join(__dirname, "../../resources/icons/icon.png");
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
      sandbox: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
  });

  // Security: open external links in browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  // Register IPC before load
  registerIpc(win);

  // Load renderer
  const url = getRendererUrl();
  if (url.startsWith("file://")) {
    await win.loadFile(path.join(__dirname, "../dist/index.html"));
  } else {
    await win.loadURL(url);
  }

  win.once("ready-to-show", () => {
    win.show();
    win.focus();
    // If launched with APK file, forward it
    if (pendingApkFile) {
      win.webContents.send("aem:openApkFile", pendingApkFile);
      pendingApkFile = null;
    }
  });

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
  // Security: disable navigation to file:// outside app
  app.on("web-contents-created", (_e, contents) => {
    contents.on("will-navigate", (e, url) => {
      const parsed = new URL(url);
      if (parsed.protocol === "file:" && !url.includes("dist")) e.preventDefault();
    });
  });

  createMenu();
  await createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // Start ADB server in background if SDK exists
  try {
    const mgr = EmulatorManager.getInstance();
    const sdk = await mgr.getSdkStatus();
    if (sdk.installed) await mgr.startAdbServer();
  } catch {}
});

app.on("window-all-closed", () => {
  // Keep emulator running? Opt to stop emulator on quit
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", async (e) => {
  // Gracefully stop emulator if running — but don't block quit indefinitely
  try {
    const mgr = EmulatorManager.getInstance();
    const status = await mgr.getStatus();
    if (status.state === "running" || status.state === "starting") {
      e.preventDefault();
      console.log("Stopping emulator before quit…");
      try {
        await Promise.race([
          mgr.stop(),
          new Promise(r => setTimeout(r, 8000)),
        ]);
      } catch {}
      app.quit();
    }
  } catch {}
});

// ─── Crash handling ───
process.on("uncaughtException", err => console.error("Uncaught", err));
process.on("unhandledRejection", err => console.error("Unhandled", err));
