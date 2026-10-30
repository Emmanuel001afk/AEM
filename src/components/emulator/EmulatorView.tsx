import { useEffect, useState, useCallback, useRef } from "react";
import { isDesktop, getDesktop } from "../../services/emulator/contract";
import { mockEmulatorBridge } from "../../services/emulator/mock";
import type { EmulatorStatus, DiagnosticsResult, SdkStatus, AvdInfo, InstalledApp } from "../../services/emulator/contract";

function useDesktopBridge() {
  const isDesk = isDesktop();
  const desktop = getDesktop();
  const bridge = desktop?.emulator || (isDesk ? null : mockEmulatorBridge as any);
  const fallback = !isDesk ? mockEmulatorBridge as any : null;
  return { isDesk, bridge: bridge || fallback, isMock: !isDesk };
}

export default function EmulatorView() {
  const { isDesk, bridge, isMock } = useDesktopBridge();
  const [status, setStatus] = useState<EmulatorStatus | null>(null);
  const [diagnostics, setDiagnostics] = useState<DiagnosticsResult | null>(null);
  const [sdk, setSdk] = useState<SdkStatus | null>(null);
  const [avds, setAvds] = useState<AvdInfo[]>([]);
  const [apps, setApps] = useState<InstalledApp[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [installing, setInstalling] = useState(false);
  const [message, setMessage] = useState<{ type: "info" | "success" | "error"; text: string } | null>(null);
  const [sdkProgress, setSdkProgress] = useState<{ phase: string; percent: number; message: string } | null>(null);
  const [selectedAvd, setSelectedAvd] = useState<string>("");
  const [systemImages, setSystemImages] = useState<any[]>([]);
  const [createForm, setCreateForm] = useState({ name: "aem_pixel_7", ramMB: 3072, cores: 4, storageMB: 8192, gpuMode: "auto" });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<number | null>(null);

  const refreshAll = useCallback(async () => {
    if (!bridge) return;
    try {
      const [st, diag, sdkSt, avdList] = await Promise.all([
        bridge.getStatus().catch(() => null),
        bridge.getDiagnostics().catch(() => null),
        bridge.getSdkStatus().catch(() => null),
        bridge.listAvds().catch(() => []),
      ]);
      if (st) setStatus(st);
      if (diag) setDiagnostics(diag);
      if (sdkSt) setSdk(sdkSt);
      if (avdList) {
        setAvds(avdList);
        if (avdList.length && !selectedAvd) setSelectedAvd(avdList[0].name);
      }
      try { const imgs = await bridge.listSystemImages(); setSystemImages(imgs || []); } catch {}
      if (st?.state === "running") {
        try { const a = await bridge.getInstalledApps(); setApps(a); } catch {}
        try { const l = await bridge.getLogs(100); setLogs(l); } catch {}
      }
    } catch (e: any) {
      // silent
    }
  }, [bridge, selectedAvd]);

  useEffect(() => {
    refreshAll();
    const id = window.setInterval(refreshAll, 4000);
    pollRef.current = id;
    return () => { if (id) clearInterval(id); };
  }, [refreshAll]);

  useEffect(() => {
    if (!bridge?.onSdkProgress) return;
    const off = bridge.onSdkProgress((p: any) => setSdkProgress(p));
    return off;
  }, [bridge]);

  const showMsg = (type: "info" | "success" | "error", text: string) => {
    setMessage({ type, text });
    setTimeout(() => setMessage(null), 6000);
  };

  const handleInstallSdk = async () => {
    if (!bridge) return;
    setSdkProgress({ phase: "prepare", percent: 0, message: "Starting SDK installation…" });
    try {
      await bridge.installSdk();
      setSdkProgress(null);
      showMsg("success", "Android SDK installed successfully. You can now create an AVD.");
      refreshAll();
    } catch (e: any) {
      setSdkProgress(null);
      showMsg("error", e.message || "SDK installation failed");
    }
  };

  const handleCreateAvd = async () => {
    if (!bridge) return;
    try {
      const img = systemImages.find((x: any) => x.installed)?.id || systemImages[0]?.id || "system-images;android-34;google_apis;x86_64";
      await bridge.createAvd({ name: createForm.name, systemImage: img, device: "pixel_7", ramMB: createForm.ramMB, cores: createForm.cores, storageMB: createForm.storageMB, gpuMode: createForm.gpuMode, snapshot: true });
      showMsg("success", `AVD ${createForm.name} created`);
      refreshAll();
    } catch (e: any) { showMsg("error", e.message); }
  };

  const handleStart = async (opts: any = {}) => {
    if (!bridge) return;
    try {
      const avdName = selectedAvd || avds[0]?.name || "aem_pixel_7";
      await bridge.start({ avdName, ...opts });
      showMsg("success", `Starting emulator ${avdName}…`);
      refreshAll();
    } catch (e: any) { showMsg("error", e.message); }
  };
  const handleStop = async () => {
    if (!bridge) return;
    try { await bridge.stop(); showMsg("info", "Emulator stopping…"); refreshAll(); } catch (e: any) { showMsg("error", e.message); }
  };
  const handleRestart = async () => {
    if (!bridge) return;
    try { await bridge.restart({ avdName: selectedAvd }); showMsg("info", "Restarting emulator…"); } catch (e: any) { showMsg("error", e.message); }
  };
  const handleWipe = async () => {
    if (!bridge) return;
    if (!confirm(`Wipe data for AVD ${selectedAvd}? This deletes all apps and storage.`)) return;
    try { await bridge.wipeAvd(selectedAvd); showMsg("success", `Wiped ${selectedAvd}`); } catch (e: any) { showMsg("error", e.message); }
  };
  const handleDeleteAvd = async () => {
    if (!bridge) return;
    if (!confirm(`Delete AVD ${selectedAvd}?`)) return;
    try { await bridge.deleteAvd(selectedAvd); showMsg("success", `Deleted ${selectedAvd}`); refreshAll(); } catch (e: any) { showMsg("error", e.message); }
  };

  const handlePickApk = async () => {
    if (!bridge) return;
    try {
      let filePaths: string[] = [];
      if (isDesk && getDesktop()?.pickApkFile) {
        const r = await getDesktop()!.pickApkFile();
        if (r.canceled) return;
        filePaths = r.filePaths;
      } else {
        fileInputRef.current?.click();
        return;
      }
      for (const fp of filePaths) {
        setInstalling(true);
        try {
          const res = await bridge.installApk(fp);
          showMsg(res.success ? "success" : "error", res.message);
          if (res.success) refreshAll();
        } finally { setInstalling(false); }
      }
    } catch (e: any) { showMsg("error", e.message); setInstalling(false); }
  };

  const handleFileInput = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files?.length || !bridge) return;
    for (const file of Array.from(files)) {
      setInstalling(true);
      try {
        // In browser, we can't install to real emulator — simulate
        const res = await bridge.installApk((file as any).path || file.name);
        showMsg(res.success ? "success" : "error", res.message);
        if (res.success) refreshAll();
      } catch (err: any) { showMsg("error", err.message); }
      finally { setInstalling(false); }
    }
    e.target.value = "";
  };

  const handleInstallStoreArtifact = async (artifact: { url: string; filename: string }) => {
    if (!bridge) return;
    setInstalling(true);
    try {
      const res = await bridge.installApkFromUrl(artifact.url, artifact.filename);
      showMsg(res.success ? "success" : "error", res.message);
      if (res.success) refreshAll();
    } catch (e: any) { showMsg("error", e.message); }
    finally { setInstalling(false); }
  };

  const handleLaunch = async (pkg: string) => {
    if (!bridge) return;
    try { const r = await bridge.launchApp(pkg); showMsg(r.success ? "success" : "error", r.message); } catch (e: any) { showMsg("error", e.message); }
  };
  const handleUninstall = async (pkg: string) => {
    if (!confirm(`Uninstall ${pkg}?`)) return;
    if (!bridge) return;
    try { const r = await bridge.uninstallApp(pkg); showMsg(r.success ? "success" : "error", r.message); if (r.success) refreshAll(); } catch (e: any) { showMsg("error", e.message); }
  };

  const state = status?.state || "not-installed";
  const isRunning = state === "running";
  const isStarting = state === "starting" || state === "installing";
  const canStart = state === "ready" || state === "not-installed";

  // Expose installStoreArtifact globally for App.tsx integration
  (window as any)._aemEmulatorInstall = handleInstallStoreArtifact;

  if (!bridge && !isMock) {
    return <section className="content emulator-page"><div className="status-message"><span>Emulator is only available in the AEM Store Windows desktop app. Download the installer from GitHub Releases.</span></div></section>;
  }

  return (
    <section className="content emulator-page">
      <div className="section-head">
        <div><span>ANDROID EMULATOR</span><h2>Emulator</h2><p className="section-sub">Genuine Android environment · install & run APKs locally</p></div>
        <div className="emulator-status-pill-wrap">
          <span className={`status-pill status-${state}`}>{state.toUpperCase().replace(/-/g, " ")}</span>
          {status?.adbSerial && <small>{status.adbSerial}</small>}
        </div>
      </div>

      {isMock && <div className="emulator-mock-banner">Mock mode — open AEM Store as a Windows desktop app for a real Android emulator. Diagnostics and install flows are simulated here.</div>}
      {message && <div className={`status-message status-${message.type}`}>{message.text}<button className="status-dismiss" onClick={() => setMessage(null)}>×</button></div>}
      {sdkProgress && <div className="progress-card"><div className="progress-track"><div className="progress-fill" style={{ width: `${sdkProgress.percent}%` }} /></div><small>{sdkProgress.phase} · {sdkProgress.message} · {sdkProgress.percent}%</small></div>}
      {status?.progress && !sdkProgress && <div className="progress-card"><div className="progress-track"><div className="progress-fill" style={{ width: `${status.progress.percent}%` }} /></div><small>{status.progress.phase} · {status.progress.message}</small></div>}

      {/* Status + Controls */}
      <div className="emulator-control-grid">
        <div className="card emulator-main-card">
          <div className="card-main">
            <h3>Android Environment</h3>
            <p>Run a genuine Android system locally on Windows. Powered by the official Android Emulator with hardware acceleration where supported.</p>
            {status?.lastError && <p className="error-text">{status.lastError}</p>}
            <div className="chip-row"><span className="chip">{isDesk ? `Desktop · ${getDesktop()?.platform}` : "Browser preview"}</span><span className="chip">{sdk?.installed ? "SDK ready" : `SDK missing: ${sdk?.needsInstall.join(", ") || "checking…"}`}</span><span className="chip">{avds.length ? `${avds.length} AVD` : "No AVD"}</span>{status?.version?.emulator && <span className="chip">{status.version.emulator.slice(0, 40)}</span>}</div>
            <div className="choice-row" style={{ marginTop: 14 }}>
              {!sdk?.installed && <button className="install" onClick={handleInstallSdk}>INSTALL SDK ({sdk?.totalDownloadMB || 1100} MB)</button>}
              {sdk?.installed && canStart && <button className="install" onClick={() => handleStart()} disabled={isStarting}>START EMULATOR</button>}
              {isStarting && <button className="choice" disabled>STARTING…</button>}
              {isRunning && <><button className="choice" onClick={handleRestart}>RESTART</button><button className="install" onClick={handleStop}>STOP</button></>}
              {status?.state === "ready" && avds.length > 0 && <button className="choice" onClick={() => handleStart({ wipeData: true })}>COLD BOOT</button>}
            </div>
            <div className="choice-row">
              {isRunning && <button className="choice" onClick={() => bridge?.takeScreenshot().then((r: any) => r.success ? showMsg("success", "Screenshot captured") : showMsg("error", r.error || "Failed"))}>SCREENSHOT</button>}
              {isRunning && <button className="choice" onClick={() => navigator.clipboard.writeText(status?.adbSerial || "")}>COPY SERIAL</button>}
              <button className="choice" onClick={refreshAll}>REFRESH</button>
            </div>
          </div>
          <div className="emulator-visual">
            <div className="phone-frame">
              <div className="phone-screen">
                {isRunning ? <div className="phone-screen-running"><span>● LIVE</span><small>{status?.adbSerial}</small><small>{status?.uptimeMs ? `${Math.round(status!.uptimeMs / 1000)}s up` : ""}</small></div> : <div className="phone-screen-off">Android off</div>}
              </div>
              <div className="phone-home" />
            </div>
            <small>Emulator runs in its own window. Use AEM Store to install APKs; they appear in Android's launcher.</small>
          </div>
        </div>

        <div className="card emulator-quick-card">
          <h3>Quick actions</h3>
          <button className="choice" onClick={handlePickApk} disabled={installing || !bridge}>{installing ? "INSTALLING…" : "INSTALL APK FILE…"}</button>
          <input ref={fileInputRef} type="file" accept=".apk,.apks,.xapk,.apkm,.zip" multiple style={{ display: "none" }} onChange={handleFileInput} />
          <p>Pick an APK/APKS/XAPK from your PC and install it to the running emulator.</p>
          <div className="choice-row">
            <button className="choice" onClick={() => bridge?.shell("input keyevent 82").then(() => showMsg("info", "Sent MENU key"))} disabled={!isRunning}>UNLOCK</button>
            <button className="choice" onClick={() => bridge?.shell("pm list features").then((out: any) => showMsg("info", out.slice(0, 300)))} disabled={!isRunning}>FEATURES</button>
          </div>
          {isRunning && <div className="choice-row"><button className="choice" onClick={() => bridge?.setLocation(6.5244, 3.3792).then((ok: any) => showMsg(ok ? "success" : "error", ok ? "Location set to Lagos" : "Failed"))}>SET LOCATION (LAGOS)</button><button className="choice" onClick={() => bridge?.rotate(1).then(() => showMsg("info", "Rotated"))}>ROTATE</button></div>}
          <p className="fine">Storage, networking and permissions are managed by Android. See diagnostics for hardware integration.</p>
        </div>
      </div>

      {/* Diagnostics */}
      <div className="setting open" style={{ marginTop: 16 }}>
        <button className="setting-head" onClick={() => setDiagnostics(d => d)}><strong>Host diagnostics</strong><span>{(diagnostics?.summary.canRun ? "● Ready" : "● Check required")}</span></button>
        <div className="setting-body">
          {!diagnostics ? <p>Loading diagnostics…</p> : <>
            <div className="diag-summary"><span>✅ {diagnostics.summary.passed} pass</span><span>⚠️ {diagnostics.summary.warnings} warn</span><span>❌ {diagnostics.summary.failed} fail</span><span className={diagnostics.summary.canRun ? "ok" : "bad"}>{diagnostics.summary.canRun ? "Can run emulator" : "Cannot run — fix required"}</span></div>
            <p>Host: {diagnostics.host.cpuModel} · {diagnostics.host.cpuCores} cores · {diagnostics.host.totalMemMB} MB RAM · {diagnostics.host.osVersion}</p>
            <div className="diag-list">
              {diagnostics.checks.map((c: any) => (
                <div key={c.id} className={`diag-check diag-${c.status}`}>
                  <strong>{c.label} — {c.status.toUpperCase()}</strong>
                  <span>{c.message}</span>
                  {c.details && <small>{c.details.slice(0, 300)}</small>}
                  {c.fix && <small className="fix">Fix: {c.fix}</small>}
                </div>
              ))}
            </div>
            <div className="choice-row"><button className="choice" onClick={() => bridge.getDiagnostics(true).then((d: any) => setDiagnostics(d))}>RE-RUN DIAGNOSTICS</button><button className="choice" onClick={() => bridge.shell ? bridge.shell("getprop").then((out: any) => setMessage({ type: "info", text: out.slice(0, 600) })) : showMsg("info", "Shell not available")}>DUMP PROPS</button></div>
          </>}
        </div>
      </div>

      {/* AVD Management */}
      <div className="setting open" style={{ marginTop: 12 }}>
        <button className="setting-head"><strong>Virtual devices (AVDs)</strong><span>{avds.length} configured</span></button>
        <div className="setting-body">
          {avds.length ? (
            <div className="avd-list">
              {avds.map(avd => (
                <div key={avd.name} className={`avd-card ${selectedAvd === avd.name ? "active" : ""}`} onClick={() => setSelectedAvd(avd.name)}>
                  <div><strong>{avd.name}</strong><small>{avd.device} · API {avd.apiLevel} · {avd.systemImage.split(";").pop()}</small></div>
                  <div className="avd-meta"><span>{avd.ramMB} MB RAM</span><span>{avd.cores} cores</span><span>{avd.storageMB} MB disk</span><span>GPU {avd.gpuMode}</span></div>
                </div>
              ))}
              <div className="choice-row">
                <button className="choice" onClick={() => handleStart({ avdName: selectedAvd })}>START {selectedAvd}</button>
                <button className="choice" onClick={handleRestart}>RESTART</button>
                <button className="choice" onClick={handleWipe}>WIPE DATA</button>
                <button className="choice" onClick={handleDeleteAvd}>DELETE</button>
              </div>
            </div>
          ) : <p>No virtual devices yet. Create one below.</p>}
          <div className="avd-create">
            <h4>Create new AVD</h4>
            <div className="build-form" style={{ gridTemplateColumns: "1fr 1fr 1fr 1fr auto" } as any}>
              <input value={createForm.name} onChange={e => setCreateForm({ ...createForm, name: e.target.value })} placeholder="AVD name" />
              <select value={createForm.ramMB} onChange={e => setCreateForm({ ...createForm, ramMB: parseInt(e.target.value) })}><option value={2048}>2 GB RAM</option><option value={3072}>3 GB RAM</option><option value={4096}>4 GB RAM</option><option value={6144}>6 GB RAM</option></select>
              <select value={createForm.cores} onChange={e => setCreateForm({ ...createForm, cores: parseInt(e.target.value) })}><option value={2}>2 cores</option><option value={4}>4 cores</option><option value={6}>6 cores</option><option value={8}>8 cores</option></select>
              <select value={createForm.gpuMode} onChange={e => setCreateForm({ ...createForm, gpuMode: e.target.value })}><option value="auto">GPU auto</option><option value="host">GPU host</option><option value="swiftshader_indirect">SwiftShader</option></select>
              <button className="install" onClick={handleCreateAvd} disabled={!sdk?.installed}>CREATE</button>
            </div>
            <p>System image: {systemImages.find((s: any) => s.installed)?.id || systemImages[0]?.id || "Will use Google APIs x86_64 · Android 14"}</p>
          </div>
        </div>
      </div>

      {/* Installed Apps */}
      <div className="setting open" style={{ marginTop: 12 }}>
        <button className="setting-head"><strong>Installed applications</strong><span>{apps.length} apps{isRunning ? ` · ${status?.adbSerial}` : " · emulator not running"}</span></button>
        <div className="setting-body">
          {!isRunning ? <p>Start the emulator to see installed apps, install APKs and launch them. Apps are stored in the Android userdata image and persist across reboots.</p> :
            apps.length === 0 ? <p>No user apps yet. Install an APK from your PC or from the AEM Store (Apps tab).</p> :
              <div className="grid">
                {apps.map(a => (
                  <article key={a.packageName} className="card">
                    <div className="app-icon">{a.label[0]?.toUpperCase() || "A"}</div>
                    <div className="card-main"><div className="meta">{a.packageName}</div><h3>{a.label}</h3><p>{a.versionName} · code {a.versionCode} {a.systemApp ? "· system" : ""}</p></div>
                    <div className="choice-row" style={{ flexDirection: "column" }}>
                      <button className="install" onClick={() => handleLaunch(a.packageName)}>LAUNCH</button>
                      <button className="choice" onClick={() => handleUninstall(a.packageName)}>UNINSTALL</button>
                      <button className="choice" onClick={() => bridge.getAppPermissions(a.packageName).then((p: any) => showMsg("info", `Permissions: ${p.requested.slice(0, 5).join(", ") || "none"}`))}>PERMISSIONS</button>
                    </div>
                  </article>
                ))}
              </div>
          }
        </div>
      </div>

      {/* Logs */}
      <div className="setting" style={{ marginTop: 12 }}>
        <div className="setting-body">
          <h4>Emulator logs</h4>
          <pre className="emulator-logs">{logs.slice(-80).join("\n") || "No logs yet"}</pre>
          <div className="choice-row"><button className="choice" onClick={() => bridge.getLogs(200).then(setLogs)}>REFRESH LOGS</button><button className="choice" onClick={() => { const blob = new Blob([logs.join("\n")], { type: "text/plain" }); const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = "emulator.log"; a.click(); }}>DOWNLOAD LOGS</button></div>
        </div>
      </div>

      {/* Host integration notes */}
      <div className="setting open" style={{ marginTop: 12 }}>
        <button className="setting-head"><strong>Host integration & limitations</strong><span>Hardware access</span></button>
        <div className="setting-body">
          <p>Emulator runs locally via QEMU with HAXM/WHPX acceleration when available. It provides genuine Android with APK install, launching, storage, networking and permission management.</p>
          <div className="integration-grid">
            <div><strong>✅ Working</strong><ul><li>Install APK/APKS/XAPK/APKM via ADB</li><li>Launch, force-stop, uninstall, clear data</li><li>Permissions grant/revoke via pm</li><li>Storage: /sdcard, app data, file push/pull</li><li>Networking: NAT, internet access</li><li>Clipboard sync, file sharing</li><li>Location (geo fix), rotation, screenshots</li><li>Graphics acceleration (host GPU / SwiftShader fallback)</li></ul></div>
            <div><strong>⚠️ Limited / requires extra setup</strong><ul><li>Camera: emulated (virtual scene) — no direct laptop webcam passthrough without config</li><li>Microphone/Bluetooth/NFC: not emulated — use physical device for testing</li><li>USB devices: limited passthrough — not all drivers supported</li><li>Google Play: only with playstore system image (separate install, requires sign-in)</li><li>Performance: needs VT-x/AMD-V + 8GB RAM for smooth 60fps; software GPU is slower</li></ul></div>
            <div><strong>❌ Not supported</strong><ul><li>Telephony/SMS on emulator (use telnet console for fake SMS)</li><li>Biometrics (fingerprint/face) — stub only</li><li>Hardware DRM Widevine L1 — L3 only</li><li>Running ARM APKs without ARM translation (use x86_64 builds when possible)</li></ul></div>
          </div>
        </div>
      </div>
    </section>
  );
}
