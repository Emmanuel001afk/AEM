import fs from "fs";
import path from "path";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { getAvdManagerPath, getSdkManagerPath } from "./sdk";
import { getAvdRoot, getEmulatorHome, DEFAULT_AVD_NAME, DEFAULT_RAM_MB, DEFAULT_CORES, DEFAULT_STORAGE_MB, DEFAULT_HEAP_MB } from "../config";
import type { AvdInfo, AvdCreateOptions } from "./types";

const execFileAsync = promisify(execFile);

function getAvdIniPath(avdName: string): string {
  return path.join(getAvdRoot(), `${avdName}.ini`);
}
function getAvdDir(avdName: string): string {
  return path.join(getAvdRoot(), `${avdName}.avd`);
}

export async function listAvds(sdkRoot?: string): Promise<AvdInfo[]> {
  const avdRoot = getAvdRoot();
  if (!fs.existsSync(avdRoot)) return [];
  const entries = fs.readdirSync(avdRoot);
  const avds: AvdInfo[] = [];
  for (const e of entries) {
    if (e.endsWith(".ini")) {
      const name = e.replace(/\.ini$/, "");
      const info = await getAvdInfo(name);
      if (info) avds.push(info);
    }
  }
  // Also try avdmanager list avd for extra info
  try {
    const avdm = sdkRoot ? getAvdManagerPath(sdkRoot) : getAvdManagerPath();
    if (fs.existsSync(avdm)) {
      const { stdout } = await execFileAsync(avdm, ["list", "avd"], { timeout: 10000, env: { ...process.env, ANDROID_AVD_HOME: avdRoot, ANDROID_SDK_HOME: path.dirname(avdRoot) } as any });
      // Could parse for validation, but filesystem is source of truth
    }
  } catch {}
  return avds;
}

export async function getAvdInfo(avdName: string): Promise<AvdInfo | null> {
  const iniPath = getAvdIniPath(avdName);
  if (!fs.existsSync(iniPath)) return null;
  const ini = fs.readFileSync(iniPath, "utf8");
  const avdDir = getAvdDir(avdName);
  const configPath = path.join(avdDir, "config.ini");
  let config = "";
  try { config = fs.readFileSync(configPath, "utf8"); } catch {}
  const combined = ini + "\n" + config;

  const get = (key: string): string | undefined => {
    const m = combined.match(new RegExp(`^${key}\\s*=\\s*(.+)$`, "m"));
    return m?.[1]?.trim().replace(/^"|"$/g, "");
  };

  const apiLevel = parseInt(get("image.sysdir.1")?.match(/android-(\d+)/)?.[1] || get("AvdId")?.match(/(\d+)/)?.[1] || "34", 10);
  const systemImage = get("image.sysdir.1") || get("sys.image") || "system-images;android-34;google_apis;x86_64";
  const device = get("hw.device.name") || get("AvdId") || "pixel_7";
  const ramMB = parseInt(get("hw.ramSize") || String(DEFAULT_RAM_MB), 10);
  const heapMB = parseInt(get("hw.heapSize") || String(DEFAULT_HEAP_MB), 10);
  const storageMB = (() => {
    const s = get("disk.dataPartition.size") || get("hw.diskSize") || "";
    if (s.endsWith("M") || s.endsWith("m")) return parseInt(s, 10);
    if (s.endsWith("G") || s.endsWith("g")) return parseInt(s, 10) * 1024;
    return DEFAULT_STORAGE_MB;
  })();
  const cores = parseInt(get("hw.cpu.ncore") || String(DEFAULT_CORES), 10);
  const gpuMode = (get("hw.gpu.mode") || "auto") as any;
  const snapshot = get("snapshot.present") !== "false" && get("fastboot.forceChosenSnapshotBoot") !== "yes";

  let createdAt: string | undefined;
  try { createdAt = fs.statSync(iniPath).birthtime.toISOString(); } catch {}

  return {
    name: avdName,
    path: avdDir,
    apiLevel,
    systemImage,
    device,
    ramMB,
    heapMB,
    storageMB,
    cores,
    gpuMode,
    snapshotEnabled: snapshot,
    createdAt,
  };
}

export async function createAvd(options: AvdCreateOptions, sdkRoot?: string): Promise<AvdInfo> {
  const root = sdkRoot;
  const avdm = root ? getAvdManagerPath(root) : getAvdManagerPath();
  if (!fs.existsSync(avdm)) throw new Error(`avdmanager not found: ${avdm}. Install SDK cmdline-tools first.`);

  const avdHome = getAvdRoot();
  const emuHome = getEmulatorHome();
  await fs.promises.mkdir(avdHome, { recursive: true });
  await fs.promises.mkdir(emuHome, { recursive: true });

  const avdName = options.name || DEFAULT_AVD_NAME;
  // If exists, remove old
  await deleteAvd(avdName);

  const device = options.device || "pixel_7";
  const systemImage = options.systemImage;
  const env = {
    ...process.env,
    ANDROID_AVD_HOME: avdHome,
    ANDROID_SDK_HOME: path.dirname(avdHome),
    ANDROID_EMULATOR_HOME: emuHome,
  } as any;

  // avdmanager create avd --force -n <name> --package <image> --device "pixel_7"
  const args = ["create", "avd", "--force", "-n", avdName, "--package", systemImage];
  if (device) args.push("--device", device);

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(avdm, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", d => { stdout += String(d); });
    proc.stderr?.on("data", d => { stderr += String(d); });
    // avdmanager may prompt "Do you wish to create a custom hardware profile? [no]"
    proc.stdin?.write("no\n");
    proc.on("close", code => {
      if (code === 0) resolve();
      else reject(new Error(`avdmanager create failed (exit ${code}): ${stderr || stdout}`.slice(0, 1000)));
    });
    proc.on("error", reject);
    setTimeout(() => {
      try { proc.kill(); } catch {}
      reject(new Error("avdmanager create timeout after 60s"));
    }, 60000);
  });

  // Patch config.ini with custom RAM, cores, storage, GPU, etc.
  await patchAvdConfig(avdName, options);

  const info = await getAvdInfo(avdName);
  if (!info) throw new Error(`AVD ${avdName} was not created at ${getAvdIniPath(avdName)}`);
  return info;
}

export async function patchAvdConfig(avdName: string, options: AvdCreateOptions): Promise<void> {
  const configPath = path.join(getAvdDir(avdName), "config.ini");
  if (!fs.existsSync(configPath)) return;
  let cfg = fs.readFileSync(configPath, "utf8");

  const set = (key: string, value: string) => {
    const re = new RegExp(`^${key}\\s*=.*$`, "m");
    const line = `${key}=${value}`;
    if (re.test(cfg)) cfg = cfg.replace(re, line);
    else cfg += `\n${line}`;
  };

  if (options.ramMB) set("hw.ramSize", String(options.ramMB));
  if (options.heapMB) set("hw.heapSize", String(options.heapMB));
  if (options.cores) set("hw.cpu.ncore", String(options.cores));
  if (options.storageMB) {
    // data partition size in MB with M suffix
    set("disk.dataPartition.size", `${options.storageMB}M`);
    set("hw.diskSize", `${options.storageMB}M`);
  }
  if (options.gpuMode) {
    set("hw.gpu.enabled", "yes");
    set("hw.gpu.mode", options.gpuMode);
  }
  if (options.sdCardMB) set("hw.sdCard", "yes"), set("sdcard.size", `${options.sdCardMB}M`), set("hw.sdCard.path", path.join(getAvdDir(avdName), "sdcard.img"));
  if (options.snapshot !== undefined) set("snapshot.present", options.snapshot ? "true" : "false");
  if (options.keyboard !== undefined) set("hw.keyboard", options.keyboard ? "yes" : "no");
  if (options.skinName) set("skin.name", options.skinName);

  // Ensure AVD is hardware-accelerated and has PlayStore quirks handled
  set("hw.cpu.arch", "x86_64");
  set("hw.keyboard", "yes");
  set("hw.backup", "no");
  set("hw.battery", "yes");

  fs.writeFileSync(configPath, cfg);
}

export async function deleteAvd(avdName: string): Promise<boolean> {
  const ini = getAvdIniPath(avdName);
  const dir = getAvdDir(avdName);
  let removed = false;
  try {
    if (fs.existsSync(ini)) { fs.unlinkSync(ini); removed = true; }
    if (fs.existsSync(dir)) { fs.rmSync(dir, { recursive: true, force: true }); removed = true; }
    // Also remove .lock files
    const lock = path.join(getAvdRoot(), `${avdName}.avd.lock`);
    if (fs.existsSync(lock)) fs.unlinkSync(lock);
  } catch {}
  return removed;
}

export async function wipeAvd(avdName: string): Promise<void> {
  const avdDir = getAvdDir(avdName);
  if (!fs.existsSync(avdDir)) throw new Error(`AVD not found: ${avdName}`);
  const toDelete = ["userdata-qemu.img", "userdata-qemu.img.qcow2", "cache.img", "cache.img.qcow2", "sdcard.img.qcow2", "snapshots.img", "snapshots", "multiinstance.lock"];
  for (const f of toDelete) {
    const p = path.join(avdDir, f);
    try {
      if (fs.existsSync(p)) {
        const stat = fs.statSync(p);
        if (stat.isDirectory()) fs.rmSync(p, { recursive: true, force: true });
        else fs.unlinkSync(p);
      }
    } catch {}
  }
}

export async function updateAvdConfig(avdName: string, patch: Partial<AvdCreateOptions>): Promise<AvdInfo | null> {
  await patchAvdConfig(avdName, patch as AvdCreateOptions);
  return getAvdInfo(avdName);
}
