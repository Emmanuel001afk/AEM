import { useEffect, useState, type ReactNode } from "react";
import type { AndroidApp, AndroidPermission, AndroidSettings, AndroidState, ApkMetadata, DesktopBridge, RuntimeDiagnostics } from "./contract";
import "./emulator.css";

type Section = "Device" | "Applications" | "Permissions" | "Files" | "Diagnostics";
const sections: Section[] = ["Device", "Applications", "Permissions", "Files", "Diagnostics"];
const errorMessage = (error: unknown) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, "") : "The operation could not be completed.";
const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export default function EmulatorPage({ bridge }: { bridge: DesktopBridge }) {
  const [state, setState] = useState<AndroidState | null>(null);
  const [diagnostics, setDiagnostics] = useState<RuntimeDiagnostics | null>(null);
  const [section, setSection] = useState<Section>("Device");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [consent, setConsent] = useState(false);
  const [settings, setSettings] = useState<AndroidSettings | null>(null);
  const [apps, setApps] = useState<AndroidApp[]>([]);
  const [apk, setApk] = useState<{ token: string; filename: string; metadata: ApkMetadata } | null>(null);
  const [permissionApp, setPermissionApp] = useState("");
  const [permissions, setPermissions] = useState<AndroidPermission[]>([]);
  const [files, setFiles] = useState<string[]>([]);
  const [file, setFile] = useState<{ token: string; filename: string; sizeBytes: number } | null>(null);
  const [storage, setStorage] = useState("");
  const [port, setPort] = useState("3000");
  const running = state?.phase === "running";
  const changing = state?.phase === "setup" || state?.phase === "starting" || state?.phase === "stopping";

  async function run(label: string, action: () => Promise<string | void>) {
    setBusy(label); setError(""); setMessage("");
    try { const result = await action(); if (result) setMessage(result); }
    catch (e) { setError(errorMessage(e)); }
    finally { setBusy(""); }
  }
  async function refreshDevice() {
    const next = await bridge.getDiagnostics();
    setDiagnostics(next); setState(next.state);
  }
  async function refreshApps() {
    const next = await bridge.listApps(); setApps(next);
    if (!next.some((app) => app.packageName === permissionApp)) { setPermissionApp(next[0]?.packageName || ""); setPermissions([]); }
  }
  async function refreshFiles() { const [next, disk] = await Promise.all([bridge.listFiles(), bridge.getStorage()]); setFiles(next); setStorage(disk); }
  async function loadPermissions(pkg: string) { setPermissionApp(pkg); setPermissions(await bridge.getPermissions(pkg)); }

  useEffect(() => {
    let active = true;
    void bridge.getState().then((next) => { if (active) { setState(next); setSettings(next.settings); } }).catch((e) => setError(errorMessage(e)));
    void refreshDevice().catch((e) => setError(errorMessage(e)));
    const unsubscribe = bridge.onState((next) => { if (active) { setState(next); setSettings((previous) => previous || next.settings); } });
    return () => { active = false; unsubscribe(); };
  }, [bridge]);
  useEffect(() => {
    if (!running) return;
    void run("Refreshing device", async () => { await refreshApps(); await refreshFiles(); });
    const timer = setInterval(() => { if (!busy) void refreshApps().catch(() => {}); }, 15000);
    return () => clearInterval(timer);
  }, [running]);
  useEffect(() => { if (running && permissionApp) void loadPermissions(permissionApp).catch((e) => setError(errorMessage(e))); }, [permissionApp, running]);

  const external = (url: string) => { void bridge.openExternal(url).catch((e) => setError(errorMessage(e))); };
  const phaseLabel = state?.phase === "running" ? "ANDROID RUNNING" : state?.phase === "starting" ? "BOOTING ANDROID" : state?.phase === "setup" ? "INSTALLING RUNTIME" : state?.phase === "stopping" ? "SHUTTING DOWN" : state?.installed ? "DEVICE STOPPED" : "SETUP REQUIRED";
  const installApk = () => run("Installing APK", async () => {
    if (!apk) throw new Error("Choose an APK first.");
    const installed = await bridge.installSelectedApk(apk.token);
    await refreshApps(); setApk(null);
    return `${installed.label} ${installed.versionName} is installed in AEM Android.`;
  });

  return <section className="content emulator-page" aria-busy={!!busy || !!changing}>
    <div className="section-head"><div><span>LOCAL ANDROID ENVIRONMENT</span><h2>AEM Android</h2></div><span className={`runtime-pill ${running ? "is-running" : ""}`}><i aria-hidden="true" />{phaseLabel}</span></div>
    <div className="emulator-hero">
      <div className="emulator-device-mark" aria-hidden="true"><span>A</span><i /></div>
      <div><p className="eyebrow">ANDROID 15 · API 35 · X86-64</p><h3>Your apps. A real Android device.</h3><p>Install, launch and test your Android apps locally. AEM manages Google’s official Android Emulator in its own window; apps run inside Android, not as Windows programs.</p><div className="emulator-actions">
        {running ? <button className="install" disabled={!!busy || !!changing} onClick={() => void run("Stopping Android", async () => { await bridge.stop(); return "Android shut down. Installed apps and files are retained."; })}>Stop Android</button> : <button className="install" disabled={!state?.installed || !!busy || !!changing} onClick={() => void run("Starting Android", async () => { const next = await bridge.start(); return `Android is ready. First boot took ${next.bootSeconds ?? "—"} seconds.`; })}>Start Android</button>}
        <button className="choice" disabled={!running || !!busy} onClick={() => { setSection("Applications"); void run("Choose APK", async () => { const picked = await bridge.chooseApk(); if (picked) setApk(picked); }); }}>Install APK</button>
        <button className="choice" disabled={!!busy || !!changing} onClick={() => void run("Checking host", refreshDevice)}>Refresh diagnostics</button>
      </div></div>
    </div>
    {error && <div className="emulator-feedback error" role="alert"><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError("")}>×</button></div>}
    {message && <div className="emulator-feedback success" role="status"><span>{message}</span><button aria-label="Dismiss message" onClick={() => setMessage("")}>×</button></div>}
    {busy && <p className="emulator-working" role="status">{busy}…</p>}
    {state?.lastError && <div className="emulator-feedback warning" role="status">{state.lastError}</div>}
    {state?.setup && <div className="runtime-progress" role="status"><div><strong>{state.setup.step}</strong><span>{state.setup.percent}%</span></div><progress max={100} value={state.setup.percent} aria-label={state.setup.step} /><p>Keep AEM open. Setup can take several minutes on your connection. Completed components are retained if a download is interrupted.</p></div>}
    {state?.transfer && <div className="runtime-progress" role="status"><div><strong>Downloading {state.transfer.filename}</strong><span>{megabytes(state.transfer.bytes)}</span></div><progress max={state.transfer.total || undefined} value={state.transfer.total ? state.transfer.bytes : undefined} /><p>SHA-256, package identity and signing identity are checked before installation.</p></div>}
    <div className="emulator-tabs" role="tablist" aria-label="Android device sections">{sections.map((name) => <button key={name} role="tab" id={`android-tab-${name}`} aria-controls={`android-panel-${name}`} aria-selected={section === name} className={section === name ? "active" : ""} onClick={() => setSection(name)}>{name}</button>)}</div>
    <div role="tabpanel" id={`android-panel-${section}`} aria-labelledby={`android-tab-${section}`}>
      {section === "Device" && <div className="emulator-columns">
        <div className="emulator-stack">
          {!state?.installed && <Panel title="Install the Android runtime" eyebrow="ONE-TIME SETUP">
            <p>AEM downloads the official Android 15 Google APIs image, emulator, ADB and build tools. A private Java runtime is included when needed. No Android Studio, account, cloud emulator or paid service is required.</p>
            <div className="runtime-facts"><span>Allow 8 GB free disk</span><span>8 GB host RAM recommended</span><span>Intel / AMD virtualization</span></div>
            <p className="muted">The download is large and the system image is not bundled in the Windows installer. A failed acceleration check is reported before boot; AEM never silently enables drivers or changes firmware.</p>
            <label className="runtime-consent"><input type="checkbox" checked={consent} disabled={!!changing} onChange={(e) => setConsent(e.target.checked)} /><span>I accept the <button className="text-link" onClick={() => external("https://developer.android.com/studio/terms")}>Android SDK license</button> and, if downloaded, the <button className="text-link" onClick={() => external("https://openjdk.org/legal/gplv2+ce.html")}>Temurin GPLv2 with Classpath Exception license</button>.</span></label>
            <button className="install" disabled={!consent || !!busy || !!changing} onClick={() => void run("Installing Android runtime", async () => { await bridge.setup({ acceptLicenses: consent }); await refreshDevice(); return "Android is installed. Review diagnostics, then start your device."; })}>Download & install Android</button>
          </Panel>}
          <Panel title="Device overview" eyebrow="PERSISTENT LOCAL DEVICE">
            <dl className="device-details"><div><dt>Android</dt><dd>15 · Google APIs · API 35</dd></div><div><dt>Device</dt><dd>AEM Phone · 720 × 1280 · 320 dpi</dd></div><div><dt>Resources</dt><dd>{state?.settings.cores ?? "—"} cores · {state?.settings.memoryMB ?? "—"} MB RAM · {state?.settings.diskGB ?? "—"} GB disk</dd></div><div><dt>Connection</dt><dd>{state?.serial || "Not running"}</dd></div><div><dt>Storage</dt><dd>Apps and files survive restarts and AEM updates</dd></div><div><dt>Graphics</dt><dd>{state?.settings.gpu === "software" ? "Software rendering" : state?.settings.gpu === "host" ? "Host GPU" : "Automatic"}</dd></div></dl>
            {running && <button className="choice" disabled={!!busy} onClick={() => void run("Opening Android settings", async () => { await bridge.openAndroidSettings(); return "Android Settings opened in the Android window."; })}>Open Android Settings</button>}
          </Panel>
          <Panel title="Windows integration" eyebrow="EXPLICIT ACCESS">
            <ul className="integration-list"><li><strong>Files</strong><span>Only files you choose are shared, into Android’s Downloads/AEM folder.</span></li><li><strong>Network</strong><span>Android has outbound NAT. Use 10.0.2.2 for the host, or add a development port forward.</span></li><li><strong>Camera & microphone</strong><span>Off by default. Enable below, allow Windows desktop access, then grant the Android app permission.</span></li><li><strong>App compatibility</strong><span>Single APKs with x86/x86-64 or Java/Kotlin code. ARM-only apps need runtime translation and may not work. No Play Store.</span></li></ul>
          </Panel>
        </div>
        <Panel title="Device resources" eyebrow="APPLIES ON NEXT BOOT">
          {settings && <form className="resource-form" onSubmit={(e) => { e.preventDefault(); void run("Saving resources", async () => { await bridge.configure(settings); return "Resource settings saved for the next Android boot."; }); }}>
            <label>CPU cores<select value={settings.cores} disabled={running || !!changing} onChange={(e) => setSettings({ ...settings, cores: Number(e.target.value) })}>{Array.from({ length: Math.min(8, diagnostics?.host.cores || 4) }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n} {n === 1 ? "core" : "cores"}</option>)}</select></label>
            <label>Memory (MB)<select value={settings.memoryMB} disabled={running || !!changing} onChange={(e) => setSettings({ ...settings, memoryMB: Number(e.target.value) })}>{Array.from({ length: Math.max(1, Math.floor((Math.min(8192, Math.floor((diagnostics?.host.totalMemoryMB || 8192) / 2)) - 1024) / 512) + 1) }, (_, i) => 1024 + i * 512).map((n) => <option key={n} value={n}>{n.toLocaleString()} MB</option>)}</select></label>
            <label>Virtual disk (GB)<select value={settings.diskGB} disabled={running || !!changing} onChange={(e) => setSettings({ ...settings, diskGB: Number(e.target.value) })}>{[4, 8, 12, 16, 24, 32, 48, 64].filter((n) => n >= (state?.settings.diskGB || 4)).map((n) => <option key={n} value={n}>{n} GB</option>)}</select></label>
            <label>Graphics<select value={settings.gpu} disabled={running || !!changing} onChange={(e) => setSettings({ ...settings, gpu: e.target.value as AndroidSettings["gpu"] })}><option value="auto">Automatic</option><option value="host">Host GPU acceleration</option><option value="software">Software compatibility mode</option></select></label>
            <label className="resource-check"><input type="checkbox" checked={settings.camera === "webcam0"} disabled={running || !!changing} onChange={(e) => setSettings({ ...settings, camera: e.target.checked ? "webcam0" : "off" })} /><span>Share the default laptop camera</span></label>
            <label className="resource-check"><input type="checkbox" checked={settings.microphone} disabled={running || !!changing} onChange={(e) => setSettings({ ...settings, microphone: e.target.checked })} /><span>Share the host microphone</span></label>
            <p className="muted">Stop Android to change resources. Software graphics does not remove the CPU virtualization requirement.</p>
            <button className="install" disabled={running || !!busy || !!changing}>Save resources</button>
          </form>}
        </Panel>
      </div>}
      {section === "Applications" && <div className="emulator-stack">
        <Panel title="Install your application" eyebrow="LOCAL APK">
          <p>Choose an APK from your computer. AEM verifies its signature and shows its identity before installing it into the running Android device. Existing app data is retained on update.</p>
          <div className="emulator-actions"><button className="install" disabled={!running || !!busy} onClick={() => void run("Reading APK", async () => { const picked = await bridge.chooseApk(); if (picked) setApk(picked); })}>Choose APK file</button><button className="choice" disabled={!running || !!busy} onClick={() => void run("Refreshing applications", refreshApps)}>Refresh applications</button></div>
          {apk && <div className="apk-preview"><div><strong>{apk.metadata.label}</strong><span>{apk.metadata.packageName} · {apk.metadata.versionName} ({apk.metadata.versionCode})</span><span>{megabytes(apk.metadata.sizeBytes)} · minimum Android API {apk.metadata.minSdk}</span><small>Signer SHA-256: <code>{apk.metadata.signingCertificateSha256}</code></small></div>{apk.metadata.armOnly && <p className="warning-text">This APK contains ARM-native code only. It may fail on this x86-64 device if the image cannot translate it.</p>}<div className="emulator-actions"><button className="install" disabled={!running || !!busy} onClick={() => void installApk()}>Install in Android</button><button className="choice" disabled={!!busy} onClick={() => setApk(null)}>Cancel</button></div></div>}
          {!running && <p className="muted">Start Android on the Device tab to install and launch applications.</p>}
        </Panel>
        <Panel title={`Installed applications · ${apps.length}`} eyebrow="ANDROID USER APPS">
          {apps.length ? <div className="android-app-list">{apps.map((app) => <article key={app.packageName}><div className="app-icon tiny">{app.packageName.split(".").at(-1)?.[0]?.toUpperCase() || "A"}</div><div className="android-app-name"><strong>{app.packageName}</strong><span>{app.versionName} · version {app.versionCode}</span></div><div className="android-app-actions"><button className="choice" disabled={!running || !!busy} onClick={() => void run("Launching app", async () => { await bridge.launchApp(app.packageName); return `${app.packageName} launched in Android.`; })}>Launch</button><button className="choice" disabled={!running || !!busy} onClick={() => { setSection("Permissions"); void run("Reading permissions", () => loadPermissions(app.packageName)); }}>Permissions</button><button className="choice" disabled={!running || !!busy} onClick={() => void run("Opening app settings", async () => { await bridge.openAndroidSettings(app.packageName); })}>Settings</button><button className="choice" disabled={!running || !!busy} onClick={() => void run("Clearing app data", async () => { const result = await bridge.clearAppData(app.packageName); return result.cancelled ? "App data was not changed." : "App data cleared."; })}>Clear data</button><button className="choice danger" disabled={!running || !!busy} onClick={() => void run("Uninstalling app", async () => { const result = await bridge.uninstallApp(app.packageName); if (!result.cancelled) await refreshApps(); return result.cancelled ? "App was not removed." : "App uninstalled."; })}>Uninstall</button></div></article>)}</div> : <p className="muted">{running ? "No user applications installed yet. Add your APK above." : "The device is stopped. Installed applications appear when Android is running."}</p>}
        </Panel>
      </div>}
      {section === "Permissions" && <Panel title="Android permission management" eyebrow="REAL ANDROID PERMISSIONS">
        <p>These are Android’s permission decisions, not Windows permissions. Special-access settings and permissions that Android does not allow ADB to change must be managed inside Android Settings.</p>
        <label className="permission-select">Application<select value={permissionApp} disabled={!running || !!busy} onChange={(e) => void run("Reading permissions", () => loadPermissions(e.target.value))}><option value="">Choose an installed app</option>{apps.map((app) => <option key={app.packageName} value={app.packageName}>{app.packageName}</option>)}</select></label>
        {permissionApp && <><div className="permission-rows">{permissions.length ? permissions.map((permission) => <label key={permission.name}><span><strong>{permission.name.replace("android.permission.", "").replaceAll("_", " ").toLowerCase()}</strong><small>{permission.name}</small></span><span className="permission-toggle"><input type="checkbox" checked={permission.granted} disabled={!running || !!busy} onChange={(e) => void run("Changing permission", async () => { setPermissions(await bridge.setPermission(permissionApp, permission.name, e.target.checked)); return "Android permission updated."; })} /><span>{permission.granted ? "Allowed" : "Denied"}</span></span></label>) : <p>No directly manageable runtime permissions are declared by this app.</p>}</div><button className="choice" disabled={!running || !!busy} onClick={() => void run("Opening Android permission settings", async () => { await bridge.openAndroidSettings(permissionApp); })}>Open app’s Android Settings</button></>}
      </Panel>}
      {section === "Files" && <div className="emulator-columns"><Panel title="Share files with Android" eyebrow="EXPLICIT FILE ACCESS">
        <p>Send a selected file to <code>/sdcard/Download/AEM</code>, or save a file from that folder to your computer. AEM does not expose your whole disk to Android.</p>
        <div className="emulator-actions"><button className="install" disabled={!running || !!busy} onClick={() => void run("Choose file", async () => { const picked = await bridge.chooseFile(); if (picked) setFile(picked); })}>Choose host file</button><button className="choice" disabled={!running || !!busy} onClick={() => void run("Refreshing files", refreshFiles)}>Refresh files</button></div>
        {file && <div className="apk-preview"><strong>{file.filename}</strong><span>{megabytes(file.sizeBytes)}</span><button className="install" disabled={!running || !!busy} onClick={() => void run("Sending file", async () => { const result = await bridge.pushFile(file.token); await refreshFiles(); setFile(null); return `Saved to ${result.remotePath}`; })}>Send to Android</button></div>}
        <div className="android-file-list">{files.length ? files.map((remote) => <div key={remote}><span>{remote.split("/").at(-1)}</span><button className="choice" disabled={!running || !!busy} onClick={() => void run("Saving file", async () => { const result = await bridge.pullFile(remote); return result.cancelled ? "Save cancelled." : "File saved to your computer."; })}>Save to PC</button></div>) : <p className="muted">No shared files yet.</p>}</div>
      </Panel><div className="emulator-stack"><Panel title="Android storage" eyebrow="PERSISTENT DATA"><pre className="storage-output">{storage || "Start Android to inspect its data partition."}</pre></Panel><Panel title="Development server access" eyebrow="ADB REVERSE"><p>Forward an Android TCP port to the same port on your Windows loopback interface. Your app can then reach a local development API.</p><form className="port-form" onSubmit={(e) => { e.preventDefault(); void run("Adding port forward", async () => { await bridge.reversePort(Number(port)); return `Android port ${port} now forwards to Windows port ${port}.`; }); }}><label>TCP port<input type="number" min={1} max={65535} value={port} onChange={(e) => setPort(e.target.value)} required /></label><button className="install" disabled={!running || !!busy}>Forward port</button></form><p className="muted">For an existing Windows service without ADB forwarding, use host address 10.0.2.2. The service must accept that connection.</p></Panel></div></div>}
      {section === "Diagnostics" && <div className="emulator-stack"><Panel title="Host & runtime diagnostics" eyebrow="MEASURED, NOT ASSUMED"><div className="emulator-actions"><button className="install" disabled={!!busy || !!changing} onClick={() => void run("Checking host", refreshDevice)}>Run checks</button><button className="choice" disabled={!!busy} onClick={() => void run("Exporting diagnostics", async () => { const result = await bridge.exportDiagnostics(); return result.cancelled ? "Export cancelled." : "Diagnostics saved."; })}>Export diagnostics</button><button className="choice" disabled={!!busy} onClick={() => void run("Opening logs", async () => { await bridge.openLogs(); })}>Open log folder</button></div>
        {diagnostics && <><p className="diagnostic-host">{diagnostics.host.cpu} · {diagnostics.host.cores} logical cores · {diagnostics.host.totalMemoryMB.toLocaleString()} MB RAM · {diagnostics.host.freeDiskGB ?? "unknown"} GB free</p><div className="diagnostic-checks">{diagnostics.checks.map((check) => <article key={check.id}><span className={`check-status ${check.status}`}>{check.status === "pass" ? "✓" : check.status === "warn" ? "!" : "×"}</span><div><strong>{check.label}</strong><p>{check.detail}</p></div></article>)}</div>{diagnostics.virtualization && <details className="raw-diagnostics"><summary>Firmware / hypervisor details</summary><pre>{diagnostics.virtualization}</pre></details>}</>}
      </Panel><Panel title="Help Windows run Android" eyebrow="HOST REQUIREMENTS"><ol className="diagnostic-help"><li>Use 64-bit Windows on an Intel/AMD PC. Windows on ARM is not supported by this release.</li><li>Enable Intel VT-x or AMD-V/SVM in your firmware settings. AEM cannot change firmware for you.</li><li>Enable <strong>Windows Hypervisor Platform</strong> in Windows Features and restart. WHPX availability depends on your Windows edition, firmware and other virtualization software.</li><li>Keep camera and microphone access enabled for desktop apps in Windows Privacy settings if you choose to share them.</li><li>If graphics fail, stop Android and select software graphics. CPU acceleration is still required.</li></ol><button className="choice" disabled={!!busy} onClick={() => external("https://developer.android.com/studio/run/emulator-acceleration")}>Read the official acceleration guide</button></Panel><Panel title="Recent runtime activity" eyebrow="LOCAL LOG"><details className="raw-diagnostics"><summary>Show recent log entries</summary><pre>{state?.logs.join("\n") || "No runtime activity yet."}</pre></details></Panel><Panel title="Reset Android data" eyebrow="DESTRUCTIVE ACTION"><p>Delete the Android device’s apps, accounts and files while retaining the downloaded SDK. Stop Android first. AEM asks for confirmation.</p><button className="choice danger" disabled={running || !!busy || !!changing || !state?.installed} onClick={() => void run("Resetting Android", async () => { const result = await bridge.resetDevice(); return result.cancelled ? "Android data was not changed." : "Android data reset. The next boot is a clean device."; })}>Reset Android data</button></Panel></div>}
    </div>
    <p className="emulator-footnote">Local execution · No mandatory cloud service · Google APIs image without Play Store · Android and Java components retain their own licenses.</p>
  </section>;
}
function Panel({ title, eyebrow, children }: { title: string; eyebrow: string; children: ReactNode }) { return <section className="emulator-panel"><span className="eyebrow">{eyebrow}</span><h3>{title}</h3>{children}</section>; }
