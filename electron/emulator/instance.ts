import { spawn, execFile, ChildProcess } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import os from "os";
import { getEmulatorPath, getAdbPath } from "./sdk";
import { getAvdRoot, getEmulatorHome, getLogsRoot, ADB_CONNECT_TIMEOUT_MS, EMULATOR_BOOT_TIMEOUT_MS, EMULATOR_FLAGS } from "../config";
import type { EmulatorStatus, EmulatorLogEntry, EmulatorLaunchOptions } from "./types";
import { adbDevices, adbWaitForDevice, adbWaitForBoot, adbExec } from "./adb";

const execFileAsync = promisify(execFile);

export class EmulatorInstance {
  private proc: ChildProcess | null = null;
  private readyProgressTimer: ReturnType<typeof setTimeout> | null = null;
  private status: EmulatorStatus = {
    state: "not-installed",
    avdName: null,
    pid: null,
    adbSerial: null,
    uptimeMs: null,
    bootCompleted: false,
    lastError: null,
  };
  private logs: EmulatorLogEntry[] = [];
  private startTime: number | null = null;
  private logStream: fs.WriteStream | null = null;
  private sdkRoot: string;
  private onStatusChange?: (s: EmulatorStatus) => void;

  constructor(sdkRoot: string, onStatusChange?: (s: EmulatorStatus) => void) {
    this.sdkRoot = sdkRoot;
    this.onStatusChange = onStatusChange;
  }

  getStatus(): EmulatorStatus {
    if (this.status.state === "running" && this.startTime) {
      return { ...this.status, uptimeMs: Date.now() - this.startTime };
    }
    return { ...this.status };
  }

  getLogs(limit = 500): EmulatorLogEntry[] {
    return this.logs.slice(-limit);
  }

  private pushLog(level: EmulatorLogEntry["level"], source: EmulatorLogEntry["source"], message: string) {
    const entry: EmulatorLogEntry = { timestamp: new Date().toISOString(), level, source, message: message.slice(0, 2000) };
    this.logs.push(entry);
    if (this.logs.length > 2000) this.logs.shift();
    // also write to file if stream open
    try {
      this.logStream?.write(`[${entry.timestamp}] [${level}] [${source}] ${message}\n`);
    } catch {}
  }

  private setStatus(patch: Partial<EmulatorStatus>) {
    this.status = { ...this.status, ...patch };
    this.onStatusChange?.(this.getStatus());
  }

  private getEnv(): NodeJS.ProcessEnv {
    const avdHome = getAvdRoot();
    const emuHome = getEmulatorHome();
    return {
      ...process.env,
      ANDROID_AVD_HOME: avdHome,
      ANDROID_SDK_HOME: path.dirname(avdHome),
      ANDROID_EMULATOR_HOME: emuHome,
      ANDROID_SDK_ROOT: this.sdkRoot,
      ANDROID_HOME: this.sdkRoot,
    } as any;
  }

  private getEmulatorBin(): string {
    const p = getEmulatorPath(this.sdkRoot);
    if (!fs.existsSync(p)) throw new Error(`Emulator binary not found at ${p}. Install SDK first.`);
    return p;
  }

  async start(options: EmulatorLaunchOptions = {}): Promise<EmulatorStatus> {
    if (this.proc && !this.proc.killed) {
      throw new Error(`Emulator already running (pid ${this.proc.pid})`);
    }

    const avdName = options.avdName || (await this.resolveDefaultAvd()) || "aem_pixel_7";
    const emulatorBin = this.getEmulatorBin();

    // Ensure logs dir
    const logsDir = getLogsRoot();
    await fs.promises.mkdir(logsDir, { recursive: true });
    const logFile = path.join(logsDir, `emulator-${avdName}-${Date.now()}.log`);
    this.logStream = fs.createWriteStream(logFile, { flags: "a" });

    this.setStatus({
      state: "starting",
      avdName,
      pid: null,
      adbSerial: null,
      bootCompleted: false,
      lastError: null,
      progress: { phase: "launch", percent: 10, message: `Starting AVD ${avdName}…` },
    });
    this.pushLog("info", "system", `Launching emulator: ${emulatorBin} @${avdName} ${JSON.stringify(options)}`);
    this.startTime = Date.now();

    const args: string[] = [`@${avdName}`];

    // AVD home handling is via env, but also pass -ports? Let emulator auto-assign
    // Window & UI options
    if (options.noWindow) args.push("-no-window");

    // GPU mode
    const gpuMode = options.gpuMode || "auto";
    args.push("-gpu", gpuMode);

    // RAM / cores override via -memory / -cores? Emulator uses AVD config, but we can pass -cores
    if (options.cores) args.push("-cores", String(options.cores));
    if (options.ramMB) args.push("-memory", String(options.ramMB));

    // Boot mode
    if (options.wipeData) args.push("-wipe-data");
    if (options.bootMode === "cold") args.push(...EMULATOR_FLAGS.coldBoot);
    else if (options.bootMode === "quick") {
      // default quick boot
    } else if (options.bootMode === "snapshot" && options.snapshotName) {
      args.push("-snapshot", options.snapshotName);
    }

    // Common performance flags
    // Quick boot may save its snapshot on graceful shutdown; cold boot flags disable it.
    // Enable host audio, camera passthrough where supported
    // Keep default networking (NAT)
    // Allow emulator to use host GPU acceleration automatically

    if (options.extraArgs?.length) args.push(...options.extraArgs);

    this.pushLog("info", "emulator", `Spawn: ${emulatorBin} ${args.join(" ")}`);

    const env = this.getEnv();

    // On Windows, emulator needs to run detached but we keep handle
    this.proc = spawn(emulatorBin, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
      windowsHide: true,
    });

    this.setStatus({ pid: this.proc.pid || null, progress: { phase: "boot", percent: 20, message: "Emulator process started, waiting for ADB…" } });

    this.proc.stdout?.on("data", d => {
      const msg = String(d).trim();
      if (msg) this.pushLog("info", "emulator", msg);
    });
    this.proc.stderr?.on("data", d => {
      const msg = String(d).trim();
      if (!msg) return;
      const level = /error|fail/i.test(msg) ? "error" : /warn/i.test(msg) ? "warn" : "info";
      this.pushLog(level as any, "emulator", msg);
    });
    this.proc.on("error", err => {
      this.pushLog("error", "system", `Spawn error: ${err.message}`);
      this.setStatus({ state: "error", lastError: err.message, progress: undefined });
    });
    this.proc.on("close", (code, signal) => {
      const wasRunning = this.status.state === "running";
      this.pushLog(wasRunning ? "warn" : "info", "system", `Emulator exited code=${code} signal=${signal}`);
      if (this.status.state === "starting" || this.status.state === "running") {
        this.setStatus({
          state: code === 0 ? "ready" : "error",
          lastError: code !== 0 ? `Emulator exited with code ${code}${signal ? ` signal ${signal}` : ""}` : null,
          pid: null,
          adbSerial: null,
          bootCompleted: false,
          progress: undefined,
        });
      }
      this.proc = null;
      this.startTime = null;
      try { this.logStream?.end(); } catch {}
      this.logStream = null;
    });

    // Wait for ADB device to appear
    this.pushLog("info", "adb", "Waiting for ADB device…");
    const adbOk = await this.waitForAdbDevice(ADB_CONNECT_TIMEOUT_MS);
    if (!adbOk) {
      this.pushLog("error", "adb", "ADB device did not appear within timeout");
      // Check if process still alive; if not, report error
      if (!this.proc || this.proc.killed) {
        throw new Error(`Emulator failed to start. Check logs at ${logFile}`);
      }
      // Continue anyway, but mark as error?
      this.setStatus({ state: "error", lastError: "ADB device not detected — emulator may still be booting or GPU acceleration failed", progress: undefined });
      return this.getStatus();
    }

    const serial = this.status.adbSerial;
    if (!serial) throw new Error("No ADB serial after device appeared");

    this.setStatus({ progress: { phase: "boot", percent: 60, message: `Device ${serial} online, waiting for Android boot…` } });
    this.pushLog("info", "adb", `Device ${serial} detected, waiting for sys.boot_completed`);

    const bootOk = await adbWaitForBoot(this.sdkRoot, serial, EMULATOR_BOOT_TIMEOUT_MS);
    if (!bootOk) {
      this.setStatus({ state: "error", bootCompleted: false, lastError: "Android boot did not complete before timeout", progress: undefined });
      throw new Error("Emulator boot timeout: a responsive shell is not a completed Android boot");
    }

    this.pushLog("info", "system", `Emulator ${avdName} (${serial}) boot completed in ${Math.round((Date.now() - (this.startTime || 0)) / 1000)}s`);
    this.setStatus({
      state: "running",
      adbSerial: serial,
      bootCompleted: true,
      progress: { phase: "ready", percent: 100, message: "Android is ready" },
    });

    // Clear progress after a moment
    if (this.readyProgressTimer) clearTimeout(this.readyProgressTimer);
    this.readyProgressTimer = setTimeout(() => {
      this.readyProgressTimer = null;
      if (this.status.state === "running") this.setStatus({ progress: undefined });
    }, 3000);

    // Unlock screen (swipe) for automation
    try {
      await adbExec(this.sdkRoot, ["-s", serial, "shell", "input", "keyevent", "82"]);
      await adbExec(this.sdkRoot, ["-s", serial, "shell", "svc", "power", "stayalive", "true"]);
    } catch {}

    return this.getStatus();
  }

  private async waitForAdbDevice(timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const devices = await adbDevices(this.sdkRoot);
      // Never attach to another tool's emulator simply because it appeared first.
      for (const serial of devices.filter(d=>d.startsWith("emulator-"))) {
        const name = await adbExec(this.sdkRoot,["-s",serial,"emu","avd","name"],5000);
        if (!name.success || name.stdout.split(/\r?\n/)[0].trim() !== this.status.avdName) continue;
        const state = await adbExec(this.sdkRoot,["-s",serial,"get-state"]);
        if (state.success && state.stdout.trim() === "device") {
          this.setStatus({ adbSerial: serial, progress: { phase: "boot", percent: 40, message: `Managed device ${serial} detected` } });
          return true;
        }
      }
      // Check if process died
      if (!this.proc || this.proc.exitCode !== null) return false;
      await new Promise(r => setTimeout(r, 1500));
    }
    return false;
  }

  private async resolveDefaultAvd(): Promise<string | null> {
    const avdRoot = getAvdRoot();
    if (!fs.existsSync(avdRoot)) return null;
    const inis = fs.readdirSync(avdRoot).filter(f => f.endsWith(".ini"));
    if (inis.length === 0) return null;
    // Prefer aem_pixel_7
    if (inis.includes("aem_pixel_7.ini")) return "aem_pixel_7";
    return inis[0].replace(/\.ini$/, "");
  }

  async stop(force = false): Promise<void> {
    if (!this.proc && !this.status.adbSerial) {
      this.setStatus({ state: "ready", pid: null, adbSerial: null, bootCompleted: false });
      return;
    }
    this.setStatus({ state: "stopping", progress: { phase: "shutdown", percent: 50, message: "Stopping emulator…" } });
    this.pushLog("info", "system", `Stopping emulator ${this.status.adbSerial || this.status.avdName} (force=${force})`);

    const serial = this.status.adbSerial;
    if (serial && !force) {
      try {
        await adbExec(this.sdkRoot, ["-s", serial, "emu", "kill"], 8000);
        // Wait for process to exit gracefully
        for (let i = 0; i < 10; i++) {
          if (!this.proc || this.proc.exitCode !== null) break;
          await new Promise(r => setTimeout(r, 1000));
        }
      } catch {}
    }

    if (this.proc && !this.proc.killed) {
      try {
        this.proc.kill(force ? "SIGKILL" : "SIGTERM");
        // Wait a bit
        for (let i = 0; i < 5; i++) {
          if (this.proc.exitCode !== null) break;
          await new Promise(r => setTimeout(r, 800));
        }
        if (this.proc.exitCode === null) {
          try { this.proc.kill("SIGKILL"); } catch {}
        }
      } catch {}
    }

    if (this.readyProgressTimer) {
      clearTimeout(this.readyProgressTimer);
      this.readyProgressTimer = null;
    }

    // On Windows, fallback to async taskkill if still hanging
    if (process.platform === "win32" && Number.isInteger(this.status.pid) && (this.status.pid || 0) > 0 && (!this.proc || this.proc.exitCode === null)) {
      try {
        await execFileAsync("taskkill", ["/PID", String(this.status.pid), "/T", "/F"], { timeout: 5000, windowsHide: true });
      } catch {}
    }

    this.proc = null;
    this.startTime = null;
    this.setStatus({ state: "ready", pid: null, adbSerial: null, bootCompleted: false, progress: undefined });
    this.pushLog("info", "system", "Emulator stopped");
    try { this.logStream?.end(); } catch {}
    this.logStream = null;
  }

  async restart(options?: EmulatorLaunchOptions): Promise<EmulatorStatus> {
    await this.stop(false);
    await new Promise(r => setTimeout(r, 2000));
    return this.start(options || { avdName: this.status.avdName || undefined });
  }

  isRunning(): boolean {
    return this.status.state === "running" && !!this.proc && !this.proc.killed;
  }

  getAdbSerial(): string | null {
    return this.status.adbSerial;
  }

  getAvdName(): string | null {
    return this.status.avdName;
  }
}
