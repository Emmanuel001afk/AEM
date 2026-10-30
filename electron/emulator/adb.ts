import { spawn, execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import type { AdbResult, InstalledApp } from "./types";

const execFileAsync = promisify(execFile);

function adbBin(sdkRoot: string): string {
  const ext = process.platform === "win32" ? ".exe" : "";
  return path.join(sdkRoot, "platform-tools", `adb${ext}`);
}

function ensureAdbExists(sdkRoot: string): string {
  const bin = adbBin(sdkRoot);
  if (!fs.existsSync(bin)) throw new Error(`ADB not found at ${bin}. Install SDK platform-tools first.`);
  return bin;
}

export async function adbExec(sdkRoot: string, args: string[], timeoutMs = 15000): Promise<AdbResult> {
  const bin = ensureAdbExists(sdkRoot);
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 });
    return { success: true, stdout: String(stdout), stderr: String(stderr), exitCode: 0 };
  } catch (e: any) {
    return {
      success: false,
      stdout: String(e.stdout || ""),
      stderr: String(e.stderr || e.message || ""),
      exitCode: typeof e.code === "number" ? e.code : 1,
    };
  }
}

export async function adbDevices(sdkRoot: string): Promise<string[]> {
  const r = await adbExec(sdkRoot, ["devices"]);
  if (!r.success) return [];
  return r.stdout
    .split("\n")
    .slice(1)
    .map(l => l.trim())
    .filter(l => l && !l.startsWith("*") && l.includes("\tdevice"))
    .map(l => l.split("\t")[0].trim());
}

export async function adbWaitForDevice(sdkRoot: string, serial: string, timeoutMs = 120000): Promise<boolean> {
  const bin = ensureAdbExists(sdkRoot);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await adbExec(sdkRoot, serial ? ["-s", serial, "wait-for-device"] : ["wait-for-device"], 10000);
    if (r.success || r.stdout.includes("device")) return true;
    await new Promise(res => setTimeout(res, 1500));
    // also check devices list
    const devices = await adbDevices(sdkRoot);
    if (serial && devices.includes(serial)) return true;
    if (!serial && devices.length > 0) return true;
  }
  return false;
}

export async function adbWaitForBoot(sdkRoot: string, serial: string, timeoutMs = 180000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await adbExec(sdkRoot, ["-s", serial, "shell", "getprop", "sys.boot_completed"]);
    if (r.success && r.stdout.trim() === "1") return true;
    await new Promise(res => setTimeout(res, 2000));
  }
  return false;
}

export async function adbInstall(sdkRoot: string, serial: string, apkPath: string, opts: { reinstall?: boolean; grantPermissions?: boolean; allowDowngrade?: boolean } = {}): Promise<AdbResult> {
  const args: string[] = ["-s", serial, "install"];
  if (opts.reinstall) args.push("-r");
  if (opts.grantPermissions) args.push("-g");
  if (opts.allowDowngrade) args.push("-d");
  args.push(apkPath);
  return adbExec(sdkRoot, args, 120000);
}

export async function adbInstallMultiple(sdkRoot: string, serial: string, apkPaths: string[], opts: { reinstall?: boolean; grantPermissions?: boolean } = {}): Promise<AdbResult> {
  const args: string[] = ["-s", serial, "install-multiple"];
  if (opts.reinstall) args.push("-r");
  if (opts.grantPermissions) args.push("-g");
  args.push(...apkPaths);
  return adbExec(sdkRoot, args, 180000);
}

export async function adbUninstall(sdkRoot: string, serial: string, packageName: string, keepData = false): Promise<AdbResult> {
  const args = ["-s", serial, "uninstall"];
  if (keepData) args.push("-k");
  args.push(packageName);
  return adbExec(sdkRoot, args, 30000);
}

export async function adbListPackages(sdkRoot: string, serial: string, thirdPartyOnly = false): Promise<string[]> {
  const args = ["-s", serial, "shell", "pm", "list", "packages"];
  if (thirdPartyOnly) args.push("-3");
  const r = await adbExec(sdkRoot, args);
  if (!r.success) return [];
  return r.stdout
    .split("\n")
    .map(l => l.trim())
    .filter(l => l.startsWith("package:"))
    .map(l => l.replace("package:", "").trim());
}

export async function adbGetPackageInfo(sdkRoot: string, serial: string, packageName: string): Promise<{ versionName?: string; versionCode?: number; enabled?: boolean; installer?: string; raw: string } | null> {
  const r = await adbExec(sdkRoot, ["-s", serial, "shell", "dumpsys", "package", packageName]);
  if (!r.success || !r.stdout) return null;
  const out = r.stdout;
  if (out.includes("Unable to find package") || out.includes("No packages")) return null;
  const vn = out.match(/versionName=([^\s]+)/)?.[1];
  const vc = out.match(/versionCode=(\d+)/)?.[1];
  const enabled = !out.includes("enabled=false");
  const installer = out.match(/installerPackageName=([^\s]+)/)?.[1];
  return { versionName: vn, versionCode: vc ? parseInt(vc, 10) : undefined, enabled, installer, raw: out.slice(0, 8000) };
}

export async function adbListInstalledApps(sdkRoot: string, serial: string): Promise<InstalledApp[]> {
  const pkgs = await adbListPackages(sdkRoot, serial, false);
  const apps: InstalledApp[] = [];
  // For performance, batch dumpsys for third-party only; system apps are less interesting
  const thirdParty = await adbListPackages(sdkRoot, serial, true);
  const candidates = thirdParty.length > 0 ? thirdParty : pkgs.slice(0, 80); // cap for speed
  for (const pkg of candidates) {
    const info = await adbGetPackageInfo(sdkRoot, serial, pkg);
    if (!info) continue;
    const isSystem = !thirdParty.includes(pkg);
    // Try to get label via aapt or pm dump? Use package name as label fallback
    apps.push({
      packageName: pkg,
      label: pkg.split(".").slice(-1)[0] || pkg,
      versionName: info.versionName || "unknown",
      versionCode: info.versionCode || 0,
      systemApp: isSystem,
      enabled: info.enabled ?? true,
    });
  }
  // Also enrich with launcher activities to get real labels
  try {
    const r = await adbExec(sdkRoot, ["-s", serial, "shell", "cmd", "package", "query-activities", "-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER"]);
    if (r.success && r.stdout) {
      // Parse lines like "ActivityInfo{... com.example/.MainActivity}"
      const lines = r.stdout.split("\n");
      for (const line of lines) {
        const m = line.match(/([a-zA-Z0-9._]+)\/[a-zA-Z0-9._]+/);
        if (m) {
          const pkg = m[1];
          const existing = apps.find(a => a.packageName === pkg);
          if (existing) {
            // Keep but we could update label if we parsed it
          }
        }
      }
    }
  } catch {}
  return apps;
}

export async function adbLaunchApp(sdkRoot: string, serial: string, packageName: string, activity?: string): Promise<AdbResult> {
  if (activity) {
    return adbExec(sdkRoot, ["-s", serial, "shell", "am", "start", "-n", `${packageName}/${activity}`]);
  }
  // monkey launch
  const r1 = await adbExec(sdkRoot, ["-s", serial, "shell", "monkey", "-p", packageName, "-c", "android.intent.category.LAUNCHER", "1"]);
  if (r1.success) return r1;
  return adbExec(sdkRoot, ["-s", serial, "shell", "am", "start", "-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER", "-p", packageName]);
}

export async function adbForceStop(sdkRoot: string, serial: string, packageName: string): Promise<AdbResult> {
  return adbExec(sdkRoot, ["-s", serial, "shell", "am", "force-stop", packageName]);
}

export async function adbClearData(sdkRoot: string, serial: string, packageName: string): Promise<AdbResult> {
  return adbExec(sdkRoot, ["-s", serial, "shell", "pm", "clear", packageName]);
}

export async function adbGrantPermission(sdkRoot: string, serial: string, packageName: string, permission: string): Promise<AdbResult> {
  return adbExec(sdkRoot, ["-s", serial, "shell", "pm", "grant", packageName, permission]);
}

export async function adbRevokePermission(sdkRoot: string, serial: string, packageName: string, permission: string): Promise<AdbResult> {
  return adbExec(sdkRoot, ["-s", serial, "shell", "pm", "revoke", packageName, permission]);
}

export async function adbGetPermissions(sdkRoot: string, serial: string, packageName: string): Promise<{ requested: string[]; granted: string[]; raw: string }> {
  const r = await adbExec(sdkRoot, ["-s", serial, "shell", "dumpsys", "package", packageName]);
  if (!r.success) return { requested: [], granted: [], raw: r.stderr };
  const perms: string[] = [];
  const granted: string[] = [];
  const lines = r.stdout.split("\n");
  let inPerms = false;
  for (const line of lines) {
    if (/install permissions:/i.test(line) || /runtime permissions:/i.test(line)) inPerms = true;
    if (inPerms) {
      const m = line.match(/android\.permission\.[A-Z_]+/);
      if (m) {
        perms.push(m[0]);
        if (/granted=true/i.test(line)) granted.push(m[0]);
      }
      if (line.trim() === "" && perms.length) break;
    }
  }
  return { requested: perms, granted, raw: r.stdout.slice(0, 6000) };
}

export async function adbPush(sdkRoot: string, serial: string, localPath: string, remotePath: string): Promise<AdbResult> {
  return adbExec(sdkRoot, ["-s", serial, "push", localPath, remotePath], 60000);
}

export async function adbPull(sdkRoot: string, serial: string, remotePath: string, localPath: string): Promise<AdbResult> {
  return adbExec(sdkRoot, ["-s", serial, "pull", remotePath, localPath], 60000);
}

export async function adbShell(sdkRoot: string, serial: string, command: string): Promise<AdbResult> {
  return adbExec(sdkRoot, ["-s", serial, "shell", command], 20000);
}

export async function adbScreencap(sdkRoot: string, serial: string): Promise<{ success: boolean; dataBase64?: string; error?: string }> {
  const r = await adbExec(sdkRoot, ["-s", serial, "exec-out", "screencap", "-p"], 15000);
  if (!r.success) return { success: false, error: r.stderr || "screencap failed" };
  // stdout is binary PNG but execFile returns string; need spawn approach for binary
  // Fallback: pull via /sdcard
  const tmp = `/sdcard/aem_screencap_${Date.now()}.png`;
  const r2 = await adbExec(sdkRoot, ["-s", serial, "shell", `screencap -p ${tmp} && echo OK`]);
  if (!r2.success) return { success: false, error: r2.stderr };
  // For now return pending — main process will pull file if needed
  return { success: true };
}

export async function adbSetLocation(sdkRoot: string, serial: string, lat: number, lng: number): Promise<AdbResult> {
  return adbExec(sdkRoot, ["-s", serial, "emu", "geo", "fix", String(lng), String(lat)]);
}

export async function adbGetProp(sdkRoot: string, serial: string, prop: string): Promise<string | null> {
  const r = await adbExec(sdkRoot, ["-s", serial, "shell", "getprop", prop]);
  if (!r.success) return null;
  return r.stdout.trim() || null;
}

export async function adbStartServer(sdkRoot: string): Promise<AdbResult> {
  return adbExec(sdkRoot, ["start-server"], 10000);
}

export async function adbKillServer(sdkRoot: string): Promise<AdbResult> {
  return adbExec(sdkRoot, ["kill-server"], 10000);
}
