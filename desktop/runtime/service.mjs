import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import net from "node:net";
import { RUNTIME } from "./manifest.mjs";
import { runCommand, checkedCommand, downloadFile, extractZip, writeJsonAtomic, readJson, exists } from "./process.mjs";
import { defaultSettings, validateSettings, assertPackage, assertPermission, parseBadging, parseSigningCertificate, parsePermissions, parseInstalledPackage, mergeAvdConfig, emulatorArgs, accelerationResult, guestPath, safeFilename } from "./validation.mjs";

const shellQuote = (value) => `'${String(value).replace(/'/g, `'"'"'`)}'`;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Local Android lifecycle. No Electron imports: the same implementation is exercised by CI. */
export class AndroidRuntime extends EventEmitter {
  constructor(options) {
    super();
    this.root = path.resolve(options.root);
    this.sdkRoot = path.resolve(options.sdkRoot || process.env.AEM_ANDROID_HOME || path.join(this.root, "sdk"));
    this.avdHome = path.join(this.root, "avd");
    this.downloads = path.join(this.root, "downloads");
    this.staging = path.join(this.root, "staging");
    this.logFile = path.join(this.root, "logs", "android-runtime.log");
    this.configFile = path.join(this.root, "settings.json");
    this.lockFile = path.join(this.root, "session.json");
    this.platform = options.platform || process.platform;
    this.arch = options.arch || process.arch;
    this.preferPrivateJava = options.preferPrivateJava ?? process.env.AEM_PRIVATE_JAVA === "1";
    this.child = null;
    this.serial = null;
    this.operation = null;
    this.lastProgress = 0;
    this.logs = [];
    this.state = { phase: "idle", installed: false, ready: false, settings: defaultSettings(), setup: null, serial: null, lastError: null, bootSeconds: null, logs: [] };
  }
  async initialize() {
    await Promise.all([this.root, this.avdHome, this.downloads, this.staging, path.dirname(this.logFile)].map((dir) => fs.mkdir(dir, { recursive: true })));
    const saved = await readJson(this.configFile, {});
    try { this.state.settings = validateSettings(saved); } catch { this.state.settings = defaultSettings(); }
    this.state.installed = await this.isInstalled();
    this.logStream = createWriteStream(this.logFile, { flags: "a" });
    this.log("AEM Android runtime initialized", { sdkRoot: this.sdkRoot, avdHome: this.avdHome });
    return this.snapshot();
  }
  snapshot() { return structuredClone({ ...this.state, logs: this.logs.slice(-40), paths: { sdk: this.sdkRoot, avd: this.avdHome, logs: this.logFile } }); }
  publish(patch = {}) { Object.assign(this.state, patch); this.emit("state", this.snapshot()); return this.snapshot(); }
  log(message, details) {
    const text = `${new Date().toISOString()} ${message}${details ? ` ${JSON.stringify(details)}` : ""}`;
    this.logs.push(text); this.logs = this.logs.slice(-100);
    this.logStream?.write(text + "\n");
  }
  progress(step, percent, detail = "") {
    if (Date.now() - this.lastProgress < 150 && percent < 100) return;
    this.lastProgress = Date.now();
    this.publish({ setup: { step, percent: Math.max(0, Math.min(100, Math.round(percent))), detail } });
  }
  binary(kind) {
    const ext = this.platform === "win32" ? ".exe" : "";
    const paths = {
      emulator: path.join(this.sdkRoot, "emulator", `emulator${ext}`),
      adb: path.join(this.sdkRoot, "platform-tools", `adb${ext}`),
      aapt: path.join(this.sdkRoot, "build-tools", "35.0.1", `aapt${ext}`),
      apksignerJar: path.join(this.sdkRoot, "build-tools", "35.0.1", "lib", "apksigner.jar"),
    };
    if (!paths[kind]) throw new Error(`Unknown runtime tool: ${kind}`);
    return paths[kind];
  }
  async isInstalled() {
    const checks = await Promise.all(["emulator", "adb", "aapt", "apksignerJar"].map((name) => exists(this.binary(name))));
    return checks.every(Boolean) && await exists(path.join(this.sdkRoot, "system-images", "android-35", "google_apis", "x86_64", "system.img")) && await exists(path.join(this.avdHome, "AEM_Phone.avd", "config.ini"));
  }
  toolsRoot() { return path.join(this.sdkRoot, "cmdline-tools", "latest"); }
  async findJava() {
    const ext = this.platform === "win32" ? ".exe" : "";
    const privateJava = path.join(this.root, "java", "bin", `java${ext}`);
    if (await exists(privateJava)) return privateJava;
    if (this.preferPrivateJava) return null;
    for (const home of [process.env.AEM_JAVA_HOME, process.env.JAVA_HOME, process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "Android Studio", "jbr"), this.platform === "win32" && "C:\\Program Files\\Android\\Android Studio\\jbr"]) {
      if (home && await exists(path.join(home, "bin", `java${ext}`))) return path.join(home, "bin", `java${ext}`);
    }
    const result = await runCommand("java", ["-version"], { timeoutMs: 10000 });
    if (result.code === 0 && /version "(?:1[7-9]|[2-9]\d)/.test(result.stderr + result.stdout)) return "java";
    return null;
  }
  async javaTool(java, tool, args, options = {}) {
    const sdkmanager = tool === "sdkmanager";
    const main = sdkmanager ? "com.android.sdklib.tool.sdkmanager.SdkManagerCli" : "com.android.sdklib.tool.AvdManagerCli";
    // Match the official launcher scripts. AvdManagerCli uses the legacy sdkmanager property name.
    const property = sdkmanager ? "com.android.sdklib.toolsdir" : "com.android.sdkmanager.toolsdir";
    const classpath = path.join(this.toolsRoot(), "lib", sdkmanager ? "sdkmanager-classpath.jar" : "avdmanager-classpath.jar");
    const rootFlag = sdkmanager ? [`--sdk_root=${this.sdkRoot}`] : [];
    return runCommand(java, [`-D${property}=${this.toolsRoot()}`, "-classpath", classpath, main, ...rootFlag, ...args], { env: this.env(), timeoutMs: 1800000, ...options });
  }
  env(extra = {}) {
    return { ...process.env, ANDROID_HOME: this.sdkRoot, ANDROID_SDK_ROOT: this.sdkRoot, ANDROID_AVD_HOME: this.avdHome, ANDROID_SDK_HOME: this.root, ANDROID_EMULATOR_HOME: path.join(this.root, "android"), ...extra };
  }
  async exclusive(name, action) {
    if (this.operation) throw new Error(`${this.operation} is already in progress. Wait for it to finish.`);
    this.operation = name;
    try { return await action(); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`${name} failed`, { message });
      this.publish({ phase: "error", lastError: message, setup: null });
      throw error;
    } finally { this.operation = null; }
  }
  async configure(input) {
    if (this.operation || this.child || this.deviceTask) throw new Error("Stop Android and finish current operations before changing its resources.");
    const settings = validateSettings({ ...this.state.settings, ...input });
    const oldDisk = this.state.settings.diskGB;
    if (await exists(path.join(this.avdHome, "AEM_Phone.avd", "config.ini")) && settings.diskGB < oldDisk) throw new Error("The virtual disk can grow but cannot shrink without resetting Android data.");
    await writeJsonAtomic(this.configFile, settings);
    return this.publish({ settings });
  }
  async setup({ acceptLicenses }) {
    if (acceptLicenses !== true) throw new Error("Accept the Android SDK and Java runtime licenses before downloading.");
    if (this.platform !== "win32" || this.arch !== "x64") throw new Error("This release supports 64-bit Intel/AMD Windows only. The web and Android stores remain unchanged.");
    return this.exclusive("Android setup", async () => {
      this.publish({ phase: "setup", lastError: null });
      const free = await fs.statfs(this.root);
      if (Number(free.bavail) * Number(free.bsize) < 8 * 1024 ** 3) throw new Error("At least 8 GB of free disk space is required. Allow 16 GB for comfortable use.");
      if (os.totalmem() < 4 * 1024 ** 3) throw new Error("At least 4 GB of host RAM is required; 8 GB or more is recommended.");
      await fs.mkdir(this.sdkRoot, { recursive: true });
      this.progress("Checking Java", 2);
      let java = await this.findJava();
      if (!java) {
        const archive = path.join(this.downloads, "temurin-21.0.13+9.zip");
        if (!await exists(archive)) await downloadFile(RUNTIME.java.url, archive, { sha256: RUNTIME.java.sha256, maxBytes: 100 * 1024 ** 2, onProgress: ({ bytes, total }) => this.progress("Downloading Java 21", 3 + (total ? bytes / total * 12 : 0)) });
        else if (await import("./process.mjs").then((m) => m.sha256File(archive)) !== RUNTIME.java.sha256) throw new Error("Cached Java archive is damaged. Remove it from the runtime downloads folder and retry.");
        this.progress("Extracting private Java runtime", 16);
        const temporary = path.join(this.staging, `java-${randomUUID()}`);
        try {
          await extractZip(archive, temporary);
          const entries = await fs.readdir(temporary, { withFileTypes: true });
          const home = entries.find((entry) => entry.isDirectory() && entry.name.startsWith("jdk-"));
          if (!home) throw new Error("Java archive has an unexpected layout.");
          // Windows cannot rename a directory onto an existing empty directory.
          // Only this private, partially installed Java directory is removable here.
          await fs.rm(path.join(this.root, "java"), { recursive: true, force: true });
          await fs.rename(path.join(temporary, home.name), path.join(this.root, "java"));
        } finally { await fs.rm(temporary, { recursive: true, force: true }); }
        java = await this.findJava();
      }
      if (!java) throw new Error("Java could not be initialized.");
      this.progress("Checking Android command-line tools", 20);
      if (!await exists(path.join(this.toolsRoot(), "lib", "sdkmanager-classpath.jar"))) {
        const archive = path.join(this.downloads, `commandline-tools-${RUNTIME.commandLineTools.version}.zip`);
        if (!await exists(archive)) await downloadFile(RUNTIME.commandLineTools.url, archive, { sha256: RUNTIME.commandLineTools.sha256, maxBytes: 300 * 1024 ** 2, onProgress: ({ bytes, total }) => this.progress("Downloading Android tools", 20 + (total ? bytes / total * 15 : 0)) });
        const temporary = path.join(this.staging, `tools-${randomUUID()}`);
        try {
          this.progress("Extracting Android tools", 36);
          await extractZip(archive, temporary);
          if (!await exists(path.join(temporary, "cmdline-tools", "lib", "sdkmanager-classpath.jar"))) throw new Error("Android tools archive has an unexpected layout.");
          await fs.mkdir(path.dirname(this.toolsRoot()), { recursive: true });
          await fs.rename(path.join(temporary, "cmdline-tools"), this.toolsRoot());
        } finally { await fs.rm(temporary, { recursive: true, force: true }); }
      }
      this.progress("Accepting licensed SDK components", 40);
      const license = await this.javaTool(java, "sdkmanager", ["--licenses"], { input: "y\n".repeat(40), onLog: (text) => this.sdkProgress(text, "Accepting SDK licenses", 40, 5) });
      if (license.code !== 0) throw new Error(`SDK license setup failed: ${license.stderr.slice(-2000)}`);
      this.progress("Installing Android 15, emulator and ADB", 45);
      const install = await this.javaTool(java, "sdkmanager", ["--verbose", ...RUNTIME.packages], { input: "n\n", onLog: (text) => this.sdkProgress(text, "Installing Android 15, emulator and ADB", 45, 45) });
      if (install.code !== 0) throw new Error(`Android component installation failed. Retry setup; completed components are retained.\n${install.stderr.slice(-2500)}`);
      this.progress("Creating persistent AEM Phone", 92);
      await this.createAvd(java);
      const revision = {};
      for (const pkg of RUNTIME.packages) {
        const xml = await fs.readFile(path.join(this.sdkRoot, ...pkg.split(";"), "package.xml"), "utf8").catch(() => "");
        revision[pkg] = xml.match(/<revision>([\s\S]*?)<\/revision>/)?.[1].replace(/<[^>]+>/g, ".").replace(/\.+/g, ".").replace(/^\./, "") || "installed";
      }
      await writeJsonAtomic(path.join(this.root, "runtime-lock.json"), { manifest: RUNTIME, installed: revision, installedAt: new Date().toISOString() });
      this.state.installed = await this.isInstalled();
      if (!this.state.installed) throw new Error("Setup finished but required Android files are missing. Run diagnostics and retry setup.");
      this.progress("Android is installed", 100);
      const accel = await this.acceleration();
      this.publish({ phase: "idle", installed: true, ready: accel.available, setup: null, lastError: accel.available ? null : "Android is installed, but hardware acceleration is unavailable. See diagnostics before starting." });
      return this.snapshot();
    });
  }
  sdkProgress(text, step, base, range) {
    for (const match of text.matchAll(/(\d+)%/g)) this.progress(step, base + Number(match[1]) / 100 * range);
    const line = text.split(/\r?\n/).filter((x) => /error|warning|installing|download/i.test(x)).at(-1);
    if (line) this.log(line.trim().slice(0, 500));
  }
  async createAvd(java = null) {
    const config = path.join(this.avdHome, "AEM_Phone.avd", "config.ini");
    if (!await exists(config)) {
      const result = await this.javaTool(java || await this.findJava(), "avdmanager", ["create", "avd", "--name", RUNTIME.avdName, "--package", RUNTIME.image, "--device", "pixel_6", "--force"], { input: "no\n", timeoutMs: 120000 });
      if (result.code !== 0) throw new Error(`Could not create Android device: ${result.stderr.slice(-2000)}`);
    }
    const existing = await fs.readFile(config, "utf8");
    await fs.writeFile(config, mergeAvdConfig(existing, this.state.settings));
    await fs.writeFile(path.join(this.avdHome, "AEM_Phone.ini"), `avd.ini.encoding=UTF-8\npath=${path.join(this.avdHome, "AEM_Phone.avd")}\npath.rel=avd/AEM_Phone.avd\ntarget=android-35\n`);
  }
  async acceleration() {
    if (!await exists(this.binary("emulator"))) return { available: false, output: "Android Emulator is not installed yet." };
    return accelerationResult(await runCommand(this.binary("emulator"), ["-accel-check"], { env: this.env(), timeoutMs: 30000 }));
  }
  async diagnostics() {
    const free = await fs.statfs(this.root).catch(() => null);
    const host = { os: `${os.type()} ${os.release()} ${os.arch()}`, cpu: os.cpus()[0]?.model || "Unknown", cores: os.cpus().length, totalMemoryMB: Math.round(os.totalmem() / 1024 ** 2), freeMemoryMB: Math.round(os.freemem() / 1024 ** 2), freeDiskGB: free ? Number((Number(free.bavail) * Number(free.bsize) / 1024 ** 3).toFixed(1)) : null, supported: this.platform === "win32" && this.arch === "x64" };
    let virtualization = null;
    if (this.platform === "win32") {
      const result = await runCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Processor | Select-Object -First 1 VirtualizationFirmwareEnabled,SecondLevelAddressTranslationExtensions | ConvertTo-Json -Compress; Get-CimInstance Win32_ComputerSystem | Select-Object HypervisorPresent | ConvertTo-Json -Compress"], { timeoutMs: 15000 });
      virtualization = result.code === 0 ? result.stdout.trim() : result.stderr.slice(-1000);
    }
    const accel = this.child ? { available: true, output: "Android is running with required CPU acceleration." } : await this.acceleration();
    let cameras = [];
    if (await exists(this.binary("emulator")) && !this.child) {
      const result = await runCommand(this.binary("emulator"), ["-webcam-list"], { env: this.env(), timeoutMs: 15000 });
      cameras = result.stdout.split(/\r?\n/).filter((line) => /webcam\d/.test(line)).map((line) => line.trim());
    }
    const checks = [
      { id: "host", label: "Windows x64 host", status: host.supported ? "pass" : "fail", detail: host.os },
      { id: "memory", label: "Host memory", status: host.totalMemoryMB >= 8192 ? "pass" : host.totalMemoryMB >= 4096 ? "warn" : "fail", detail: `${host.totalMemoryMB} MB total; ${host.freeMemoryMB} MB available. Recommended: 8 GB or more.` },
      { id: "disk", label: "Free storage", status: (host.freeDiskGB || 0) >= 8 ? "pass" : "fail", detail: `${host.freeDiskGB ?? "unknown"} GB free. Allow 8 GB for setup and additional space for apps.` },
      { id: "acceleration", label: "CPU virtualization", status: accel.available ? "pass" : "fail", detail: accel.output || "Enable Intel VT-x/AMD-V in firmware and Windows Hypervisor Platform, then restart Windows. AEM does not silently change drivers or firmware." },
      { id: "runtime", label: "Android 15 runtime", status: this.state.installed ? "pass" : "warn", detail: this.state.installed ? "Pinned SDK components and persistent AEM Phone are installed." : "Install the licensed Android runtime from this page." },
      { id: "camera", label: "Host camera", status: cameras.length ? "pass" : "warn", detail: cameras.length ? cameras.join("; ") : "No camera detected, or enumeration unavailable. Camera sharing is off by default." },
    ];
    return { host, virtualization, acceleration: accel, cameras, checks, state: this.snapshot() };
  }
  async freePort() {
    for (let port = 5556; port < 5586; port += 2) {
      const available = await Promise.all([port, port + 1].map((candidate) => new Promise((resolve) => {
        const server = net.createServer();
        server.once("error", () => resolve(false));
        server.listen(candidate, "127.0.0.1", () => server.close(() => resolve(true)));
      })));
      if (available.every(Boolean)) return port;
    }
    throw new Error("No local emulator console port is free. Close another emulator and retry.");
  }
  async recoverOwnedSession() {
    const lock = await readJson(this.lockFile, null);
    if (!lock || !Number.isInteger(lock.pid) || !/^emulator-\d{4}$/.test(lock.serial || "")) return;
    const result = await runCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter 'ProcessId=${lock.pid}').CommandLine`], { timeoutMs: 10000 });
    if (result.stdout.includes(RUNTIME.avdName)) {
      this.log("Recovering AEM-owned emulator from a previous session", { pid: lock.pid });
      await runCommand(this.binary("adb"), ["-s", lock.serial, "emu", "kill"], { env: this.env(), timeoutMs: 10000 });
      await delay(2500);
      await runCommand("taskkill.exe", ["/PID", String(lock.pid), "/T", "/F"], { timeoutMs: 10000 });
    }
    await fs.rm(this.lockFile, { force: true });
  }
  async start({ headless = false } = {}) {
    if (this.child) return this.snapshot();
    if (!this.state.installed) throw new Error("Install the Android runtime first.");
    return this.exclusive("Android startup", async () => {
      const accel = await this.acceleration();
      if (!accel.available) throw new Error(`Hardware acceleration is required for a usable Android environment. ${accel.output}`);
      await this.recoverOwnedSession();
      await this.createAvd();
      const port = await this.freePort();
      this.serial = `emulator-${port}`;
      this.publish({ phase: "starting", lastError: null, bootSeconds: null, serial: this.serial });
      const args = emulatorArgs(this.state.settings, { port, headless });
      this.log("Starting official Android Emulator", { args });
      const started = Date.now();
      const child = spawn(this.binary("emulator"), args, { env: this.env(), cwd: path.dirname(this.binary("emulator")), shell: false, windowsHide: false, stdio: ["ignore", "pipe", "pipe"] });
      this.child = child;
      let exitInfo = null;
      const exited = new Promise((resolve) => child.once("exit", (code, signal) => { exitInfo = { code, signal }; resolve(exitInfo); }));
      child.once("error", (error) => { exitInfo = { code: -1, error: error.message }; });
      const capture = (chunk) => { for (const line of chunk.toString().split(/\r?\n/).filter(Boolean).slice(-20)) this.log(line.slice(0, 1000)); };
      child.stdout.on("data", capture); child.stderr.on("data", capture);
      child.once("exit", (code) => {
        if (this.child === child) {
          this.child = null;
          void fs.rm(this.lockFile, { force: true });
          this.publish({ phase: code === 0 ? "idle" : "error", serial: null, lastError: code === 0 ? null : `Android exited unexpectedly (code ${code}). See the runtime log; try software graphics if this is a GPU driver issue.` });
        }
      });
      try {
        const deadline = Date.now() + 300000;
        let booted = false;
        while (Date.now() < deadline) {
          if (exitInfo) throw new Error(`Android exited before boot. ${this.logs.slice(-8).join("\n")}`);
          const result = await runCommand(this.binary("adb"), ["-s", this.serial, "shell", "getprop", "sys.boot_completed"], { env: this.env(), timeoutMs: 8000 });
          if (result.code === 0 && result.stdout.trim() === "1") {
            const pm = await runCommand(this.binary("adb"), ["-s", this.serial, "shell", "pm", "path", "android"], { env: this.env(), timeoutMs: 10000 });
            if (pm.code === 0 && pm.stdout.includes("package:")) { booted = true; break; }
          }
          await delay(2000);
        }
        if (!booted) throw new Error("Android did not finish booting within five minutes. Check virtualization, available RAM and the runtime log.");
        await writeJsonAtomic(this.lockFile, { pid: child.pid, serial: this.serial, startedAt: new Date().toISOString() });
        return this.publish({ phase: "running", ready: true, serial: this.serial, bootSeconds: Math.round((Date.now() - started) / 1000), lastError: null });
      } catch (error) {
        if (this.child === child) { child.kill("SIGKILL"); this.child = null; await exited; }
        throw error;
      }
    });
  }
  async stop() {
    if (!this.child) { this.publish({ phase: "idle", serial: null }); return this.snapshot(); }
    if (this.operation === "Android setup" || this.deviceTask) throw new Error("Wait for the current Android operation to finish before stopping.");
    const child = this.child, serial = this.serial;
    const exit = new Promise((resolve) => child.once("exit", resolve));
    this.publish({ phase: "stopping" });
    await runCommand(this.binary("adb"), ["-s", serial, "emu", "kill"], { env: this.env(), timeoutMs: 10000 });
    const result = await Promise.race([exit.then(() => true), delay(12000).then(() => false)]);
    if (!result) {
      if (this.platform === "win32") await runCommand("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { timeoutMs: 10000 });
      else child.kill("SIGKILL");
      await exit;
    }
    this.child = null; this.serial = null;
    await fs.rm(this.lockFile, { force: true });
    return this.publish({ phase: "idle", serial: null });
  }
  async adb(args, { timeoutMs = 60000, check = true } = {}) {
    if (!this.child || !this.serial || this.state.phase === "stopping") throw new Error("Start Android before using applications or files.");
    const options = { env: this.env(), timeoutMs };
    const full = ["-s", this.serial, ...args];
    return check ? checkedCommand(this.binary("adb"), full, options) : runCommand(this.binary("adb"), full, options);
  }
  async inspectApk(file) {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size < 1024 || stat.size > 2 * 1024 ** 3) throw new Error("Choose a non-empty APK smaller than 2 GB.");
    if (path.extname(file).toLowerCase() !== ".apk") throw new Error("Choose a single .apk. Split APK/APKS/XAPK/APKM bundles are not supported by the desktop installer yet; the Android store still supports its existing families.");
    const badging = await checkedCommand(this.binary("aapt"), ["dump", "badging", file], { timeoutMs: 60000 });
    const metadata = parseBadging(badging.stdout);
    if (metadata.minSdk > RUNTIME.apiLevel) throw new Error(`This APK requires Android API ${metadata.minSdk}; AEM Phone runs API ${RUNTIME.apiLevel}.`);
    const java = await this.findJava();
    if (!java) throw new Error("Java is required to verify APK signatures.");
    const signature = await checkedCommand(java, ["-jar", this.binary("apksignerJar"), "verify", "--print-certs", file], { timeoutMs: 60000 });
    metadata.signingCertificateSha256 = parseSigningCertificate(signature.stdout);
    metadata.sizeBytes = stat.size;
    return metadata;
  }
  async withDeviceTask(name, action) {
    if (this.deviceTask) throw new Error(`${this.deviceTask} is already in progress. Wait for it to finish.`);
    this.deviceTask = name;
    this.publish({ task: name });
    try { return await action(); } finally { this.deviceTask = null; this.publish({ task: null }); }
  }
  async installApk(file, expected = {}) {
    return this.withDeviceTask("APK installation", () => this.installApkInternal(file, expected));
  }
  async installApkInternal(file, expected = {}) {
    const metadata = await this.inspectApk(file);
    if (expected.packageIdentity && metadata.packageName !== assertPackage(expected.packageIdentity)) throw new Error("APK package identity does not match the store release. Installation was blocked.");
    if (expected.signingCertificateSha256 && metadata.signingCertificateSha256 !== expected.signingCertificateSha256.replace(/:/g, "").toLowerCase()) throw new Error("APK signing certificate does not match the store release. Installation was blocked.");
    if (expected.versionCode && metadata.versionCode !== Number(expected.versionCode)) throw new Error("APK version code does not match the store release. Installation was blocked.");
    const result = await this.adb(["install", "-r", file], { timeoutMs: 300000 });
    if (!/^Success\s*$/im.test(result.stdout)) throw new Error(`Android did not confirm installation: ${result.stdout.slice(-1500)}`);
    await this.adb(["shell", "pm", "path", metadata.packageName]);
    this.log("APK installed", { package: metadata.packageName, versionCode: metadata.versionCode });
    return metadata;
  }
  async installCatalog(input) {
    if (!input || typeof input.url !== "string" || typeof input.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(input.sha256)) throw new Error("Store APK is missing its SHA-256 integrity metadata.");
    const url = new URL(input.url);
    if (url.protocol !== "https:" || !["wfvvmyixqcwosmuldxoq.supabase.co", "github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"].includes(url.hostname)) throw new Error("Store APK must come from AEM artifact storage or GitHub over HTTPS.");
    assertPackage(input.packageIdentity);
    if (!this.child || this.state.phase !== "running") throw new Error("Start Android before installing a store application.");
    if (this.operation) throw new Error(`${this.operation} is in progress. Retry the store installation when it finishes.`);
    return this.withDeviceTask("Store APK installation", async () => {
      const file = path.join(this.staging, `${randomUUID()}.apk`);
      try {
        this.publish({ transfer: { kind: "download", filename: safeFilename(input.filename || "store-app.apk"), bytes: 0, total: Number(input.sizeBytes || 0) } });
        await downloadFile(url.href, file, { sha256: input.sha256, onProgress: ({ bytes, total }) => this.publish({ transfer: { kind: "download", filename: safeFilename(input.filename || "store-app.apk"), bytes, total } }) });
        return await this.installApkInternal(file, input);
      } finally { this.publish({ transfer: null }); await fs.rm(file, { force: true }); }
    });
  }
  async listApps() {
    const result = await this.adb(["shell", "pm", "list", "packages", "-3"]);
    const packages = result.stdout.split(/\r?\n/).map((line) => line.trim().replace(/^package:/, "")).filter(Boolean).slice(0, 200);
    const apps = [];
    for (const packageName of packages) {
      assertPackage(packageName);
      const details = await this.adb(["shell", "dumpsys", "package", packageName]);
      apps.push(parseInstalledPackage(details.stdout, packageName));
    }
    return apps.sort((a, b) => a.packageName.localeCompare(b.packageName));
  }
  async launchApp(packageName) {
    assertPackage(packageName);
    const result = await this.adb(["shell", "am", "start", "-W", "-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER", "-p", packageName]);
    if (/Error:|Exception/.test(result.stdout + result.stderr)) throw new Error(`Android could not launch this app: ${result.stdout.slice(-1500)}`);
    return { launched: true, packageName };
  }
  async uninstallApp(packageName) {
    assertPackage(packageName);
    await this.adb(["uninstall", packageName], { timeoutMs: 120000 });
    return { removed: true };
  }
  async clearAppData(packageName) {
    assertPackage(packageName);
    const result = await this.adb(["shell", "pm", "clear", packageName]);
    if (!result.stdout.includes("Success")) throw new Error("Android did not confirm that app data was cleared.");
    return { cleared: true };
  }
  async permissions(packageName) {
    assertPackage(packageName);
    const result = await this.adb(["shell", "dumpsys", "package", packageName]);
    return parsePermissions(result.stdout);
  }
  async setPermission(packageName, permission, granted) {
    assertPackage(packageName); assertPermission(permission);
    if (typeof granted !== "boolean") throw new Error("Permission state must be allow or deny.");
    await this.adb(["shell", "pm", granted ? "grant" : "revoke", packageName, permission]);
    return this.permissions(packageName);
  }
  async openAndroidSettings(packageName) {
    if (packageName) { assertPackage(packageName); await this.adb(["shell", "am", "start", "-a", "android.settings.APPLICATION_DETAILS_SETTINGS", "-d", `package:${packageName}`]); }
    else await this.adb(["shell", "am", "start", "-a", "android.settings.SETTINGS"]);
    return { opened: true };
  }
  async pushFile(file) {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > 2 * 1024 ** 3) throw new Error("Choose a file smaller than 2 GB.");
    const remote = `/sdcard/Download/AEM/${safeFilename(path.basename(file))}`;
    await this.adb(["shell", "mkdir", "-p", "/sdcard/Download/AEM"]);
    await this.adb(["push", file, remote], { timeoutMs: 300000 });
    await this.adb(["shell", `am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d ${shellQuote("file://" + remote)}`]);
    return { remotePath: remote, sizeBytes: stat.size };
  }
  async listFiles() {
    const result = await this.adb(["shell", "find /sdcard/Download/AEM -maxdepth 1 -type f 2>/dev/null"], { check: false });
    return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith("/sdcard/Download/AEM/"));
  }
  async pullFile(remote, destination) {
    guestPath(remote);
    await this.adb(["pull", remote, destination], { timeoutMs: 300000 });
    return { saved: true };
  }
  async storage() { return (await this.adb(["shell", "df", "-h", "/data"])).stdout; }
  async reversePort(port) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Choose a TCP port from 1 to 65535.");
    await this.adb(["reverse", `tcp:${port}`, `tcp:${port}`]);
    return { port, guestUrl: `http://127.0.0.1:${port}`, hostService: `http://127.0.0.1:${port}` };
  }
  async resetDevice() {
    if (this.child || this.operation) throw new Error("Stop Android before resetting its data.");
    const directory = path.join(this.avdHome, "AEM_Phone.avd");
    if (path.resolve(directory) !== path.resolve(this.root, "avd", "AEM_Phone.avd")) throw new Error("Unsafe device path.");
    await fs.rm(directory, { recursive: true, force: true });
    await this.createAvd();
    this.log("AEM Phone data reset; SDK installation retained");
    return this.snapshot();
  }
  async dispose() {
    if (this.child) await this.stop().catch((error) => this.log("Shutdown failed", { message: error.message }));
    this.logStream?.end();
  }
}
