import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, session, shell } from "electron";
import electronUpdater from "electron-updater";
const { autoUpdater } = electronUpdater;
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { AndroidRuntime } from "./runtime/service.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const rendererRoot = path.resolve(directory, "../desktop-dist");
const APP_ORIGIN = "aem://store";
const devUrl = !app.isPackaged && process.env.AEM_DEV_SERVER === "http://127.0.0.1:5173" ? process.env.AEM_DEV_SERVER : null;
app.setName("AEM Store");
app.setAppUserModelId("com.aem.store.desktop");

protocol.registerSchemesAsPrivileged([{ scheme: "aem", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);

let window = null, runtime = null, quitting = false, updateCheck = false;
const selectedFiles = new Map();
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self'; connect-src 'self' https://*.supabase.co wss://*.supabase.co; object-src 'none'; base-uri 'self'; form-action 'none'; frame-src 'none'";
const runtimeRoot = process.env.AEM_RUNTIME_ROOT || (process.platform === "win32" ? path.join(process.env.LOCALAPPDATA || app.getPath("appData"), "AEM Store", "android-runtime") : path.join(app.getPath("userData"), "android-runtime"));

function isTrustedAppUrl(value) {
  try {
    const url = new URL(value);
    return (url.protocol === "aem:" && url.host === "store" && !url.username && !url.password) || Boolean(devUrl && url.origin === devUrl);
  } catch { return false; }
}
function assertSender(event) {
  if (!window || event.sender !== window.webContents || !event.senderFrame || event.senderFrame !== window.webContents.mainFrame) throw new Error("Untrusted desktop bridge caller.");
  if (!isTrustedAppUrl(event.senderFrame.url)) throw new Error("Untrusted desktop bridge origin.");
}
function handle(channel, action) {
  ipcMain.handle(`aem:${channel}`, async (event, ...args) => { assertSender(event); return action(...args); });
}
function selected(token) {
  const entry = selectedFiles.get(token);
  if (!entry || entry.expires < Date.now()) { selectedFiles.delete(token); throw new Error("File selection expired. Choose the file again."); }
  return entry.path;
}
function offerFile(filePath, metadata = {}) {
  for (const [key, value] of selectedFiles) if (value.expires < Date.now()) selectedFiles.delete(key);
  if (selectedFiles.size >= 16) selectedFiles.delete(selectedFiles.keys().next().value);
  const token = randomUUID();
  selectedFiles.set(token, { path: filePath, expires: Date.now() + 15 * 60000 });
  return { token, filename: path.basename(filePath), ...metadata };
}
async function confirm(message, detail, confirmLabel) {
  const result = await dialog.showMessageBox(window, { type: "warning", title: "AEM Store", message, detail, buttons: ["Cancel", confirmLabel], defaultId: 0, cancelId: 0, noLink: true });
  return result.response === 1;
}
function openHttps(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error("Only ordinary HTTPS links can be opened outside AEM.");
  return shell.openExternal(parsed.href);
}
async function checkUpdates() {
  if (!app.isPackaged || process.platform !== "win32") return { available: false, message: "Desktop update checks are available in the installed Windows release. The store catalog keeps its existing update mechanism." };
  if (updateCheck) return { available: false, message: "An update check is already in progress." };
  updateCheck = true;
  try {
    const result = await autoUpdater.checkForUpdates();
    const update = result?.updateInfo;
    if (!update || update.version === app.getVersion()) return { available: false, message: `AEM Store ${app.getVersion()} is up to date.` };
    const accepted = await confirm(`AEM Store ${update.version} is available`, "Download the update from the AEM GitHub release feed? The release checksum is verified before installation.", "Download update");
    if (!accepted) return { available: true, message: "Update deferred." };
    await autoUpdater.downloadUpdate();
    const restart = await confirm("Desktop update downloaded", "Restart AEM to install the update. A running Android device will be shut down first.", "Restart and install");
    if (restart) { quitting = true; await runtime?.dispose(); autoUpdater.quitAndInstall(); }
    return { available: true, message: restart ? "Installing update…" : "Update ready; it will be installed the next time you restart AEM." };
  } catch (error) {
    return { available: false, message: `Desktop update check failed: ${error.message}. Your installed version has not been changed.` };
  } finally { updateCheck = false; }
}
function registerBridge() {
  handle("state", () => runtime.snapshot());
  handle("diagnostics", () => runtime.diagnostics());
  handle("configure", (value) => runtime.configure(value));
  handle("setup", (value) => runtime.setup(value));
  handle("start", () => runtime.start());
  handle("stop", () => runtime.stop());
  handle("apps", () => runtime.listApps());
  handle("launch", (pkg) => runtime.launchApp(pkg));
  handle("uninstall", async (pkg) => {
    if (!/^[a-zA-Z][a-zA-Z0-9_.]*$/.test(String(pkg))) throw new Error("Invalid package identity.");
    if (!await confirm(`Uninstall ${pkg}?`, "The app and its private Android data will be removed. Files in Android Downloads are retained.", "Uninstall")) return { cancelled: true };
    return runtime.uninstallApp(pkg);
  });
  handle("clear-data", async (pkg) => {
    if (!/^[a-zA-Z][a-zA-Z0-9_.]*$/.test(String(pkg))) throw new Error("Invalid package identity.");
    if (!await confirm(`Clear data for ${pkg}?`, "Account state, settings and private app data will be deleted. The app remains installed.", "Clear data")) return { cancelled: true };
    return runtime.clearAppData(pkg);
  });
  handle("permissions", (pkg) => runtime.permissions(pkg));
  handle("set-permission", (pkg, permission, granted) => runtime.setPermission(pkg, permission, granted));
  handle("android-settings", (pkg) => runtime.openAndroidSettings(pkg));
  handle("choose-apk", async () => {
    const result = await dialog.showOpenDialog(window, { title: "Choose an Android APK", properties: ["openFile"], filters: [{ name: "Android application", extensions: ["apk"] }] });
    if (result.canceled || !result.filePaths[0]) return null;
    return offerFile(result.filePaths[0], { metadata: await runtime.inspectApk(result.filePaths[0]) });
  });
  handle("install-selected", (token) => runtime.installApk(selected(token)));
  handle("install-catalog", (artifact) => runtime.installCatalog(artifact));
  handle("choose-file", async () => {
    const result = await dialog.showOpenDialog(window, { title: "Send a file to Android Downloads", properties: ["openFile"] });
    if (result.canceled || !result.filePaths[0]) return null;
    const file = result.filePaths[0], stat = await fs.stat(file);
    if (stat.size > 2 * 1024 ** 3) throw new Error("Choose a file smaller than 2 GB.");
    return offerFile(file, { sizeBytes: stat.size });
  });
  handle("push-file", (token) => runtime.pushFile(selected(token)));
  handle("files", () => runtime.listFiles());
  handle("pull-file", async (remote) => {
    if (typeof remote !== "string" || !remote.startsWith("/sdcard/Download/AEM/") || remote.includes("..")) throw new Error("Invalid Android download path.");
    const result = await dialog.showSaveDialog(window, { title: "Save Android file", defaultPath: path.basename(remote) });
    if (result.canceled || !result.filePath) return { cancelled: true };
    return runtime.pullFile(remote, result.filePath);
  });
  handle("storage", () => runtime.storage());
  handle("reverse-port", (port) => runtime.reversePort(port));
  handle("reset-device", async () => {
    if (!await confirm("Reset AEM Phone?", "This permanently deletes all Android apps, accounts and device data. The SDK and AEM Store are retained.", "Delete Android data")) return { cancelled: true };
    return runtime.resetDevice();
  });
  handle("open-logs", async () => { const error = await shell.openPath(path.dirname(runtime.logFile)); if (error) throw new Error(error); return { opened: true }; });
  handle("export-diagnostics", async () => {
    const result = await dialog.showSaveDialog(window, { title: "Save AEM diagnostics", defaultPath: "aem-diagnostics.json", filters: [{ name: "JSON", extensions: ["json"] }] });
    if (result.canceled || !result.filePath) return { cancelled: true };
    await fs.writeFile(result.filePath, JSON.stringify({ application: { name: "AEM Store", version: app.getVersion() }, createdAt: new Date().toISOString(), android: await runtime.diagnostics() }, null, 2));
    return { saved: true };
  });
  handle("app-info", () => ({ version: app.getVersion(), platform: process.platform, arch: process.arch, packaged: app.isPackaged }));
  handle("check-updates", () => checkUpdates());
  handle("open-external", (url) => openHttps(url));
}
function createMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "File", submenu: [{ label: "Open Android", accelerator: "CmdOrCtrl+Shift+A", click: () => window?.webContents.send("aem:open-android") }, { type: "separator" }, { role: "quit" }] },
    { label: "Edit", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
    { label: "View", submenu: [{ role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" }] },
    { label: "Help", submenu: [{ label: "Check for desktop updates", click: () => void checkUpdates().then((result) => dialog.showMessageBox(window, { message: result.message })) }, { label: "About AEM Store", click: () => dialog.showMessageBox(window, { title: "About AEM Store", message: "AEM Store", detail: `Version ${app.getVersion()}\nYour software store, with a local Android test device.\nAndroid runtime components are governed by their respective licenses.` }) }] },
  ]));
}
async function createWindow() {
  window = new BrowserWindow({ title: "AEM Store", width: 1280, height: 860, minWidth: 900, minHeight: 640, backgroundColor: "#0b0b0f", autoHideMenuBar: true, show: false, icon: path.join(directory, "assets", "icon.png"), webPreferences: { preload: path.join(directory, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, webviewTag: false, spellcheck: true } });
  window.webContents.setWindowOpenHandler(({ url }) => { void openHttps(url).catch(() => {}); return { action: "deny" }; });
  window.webContents.on("will-navigate", (event, url) => { if (!isTrustedAppUrl(url)) event.preventDefault(); });
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.on("page-title-updated", (event) => event.preventDefault());
  
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => { window = null; });
  await window.loadURL(devUrl || `${APP_ORIGIN}/index.html`);
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
  app.whenReady().then(async () => {
    protocol.handle("aem", async (request) => {
      const url = new URL(request.url);
      if (url.protocol !== "aem:" || url.host !== "store") return new Response("Not found", { status: 404 });
      let pathname;
      try { pathname = decodeURIComponent(url.pathname); } catch { return new Response("Bad request", { status: 400 }); }
      const target = path.resolve(rendererRoot, "." + (pathname === "/" ? "/index.html" : pathname));
      if (!target.startsWith(rendererRoot + path.sep)) return new Response("Forbidden", { status: 403 });
      const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".woff2": "font/woff2" };
      try {
        const body = await fs.readFile(target);
        return new Response(body, { headers: { "Content-Type": types[path.extname(target).toLowerCase()] || "application/octet-stream", "Content-Security-Policy": CSP } });
      } catch { return new Response("Not found", { status: 404 }); }
    });
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => callback({ responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": [CSP] } }));
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    runtime = new AndroidRuntime({ root: runtimeRoot });
    await runtime.initialize();
    runtime.on("state", (state) => { if (window && !window.isDestroyed()) window.webContents.send("aem:state", state); });
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = { info: (message) => runtime.log(String(message)), warn: (message) => runtime.log(String(message)), error: (message) => runtime.log(String(message)), debug: () => {} };
    registerBridge(); createMenu(); await createWindow();
  }).catch((error) => { console.error("AEM Store startup failed", error); dialog.showErrorBox("AEM Store could not start", error.stack || error.message); app.quit(); });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault(); quitting = true;
    void runtime?.dispose().finally(() => app.quit());
  });
}
