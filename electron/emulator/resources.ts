import os from "os";
import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import type { GpuMode } from "./types";

/*
 * Mirror of the shared contract types in src/services/emulator/contract.ts.
 * Kept local here because electron/tsconfig.json uses rootDir = electron/ and
 * cannot import files under src/ without a TS6059 rootDir error. The renderer
 * side continues to use src/services/emulator/contract.ts as the single source
 * of truth; these interfaces must stay structurally compatible.
 */
export type ResourceProfileId = "lightweight" | "balanced" | "standard";

export interface HostResources {
  platform: string;
  arch: string;
  totalMemMB: number;
  freeMemMB: number;
  cpuModel: string;
  cpuCores: number;
  diskFreeMB: number | null;
  virtualizationEnabled: boolean | null;
  hypervisor: string | null;
  gpuInfo: string | null;
  osVersion: string;
}

export interface ResourceProfile {
  id: ResourceProfileId;
  name: string;
  description: string;
  ramMB: number;
  heapMB: number;
  cores: number;
  storageMB: number;
  gpuMode: string;
  snapshot: boolean;
  recommendedFor: string;
}

export interface ResourceRecommendation {
  host: HostResources;
  profiles: ResourceProfile[];
  recommended: ResourceProfileId;
  reasons: string[];
  limitations: string[];
}

/*
 * AEM Store — host-resource-aware emulator configuration.
 *
 * The emulator must never simply take "the maximum available RAM/CPU".
 * Windows itself needs memory and CPU to stay responsive, and the emulator
 * (QEMU + Android runtime) is a large, long-lived process. These profiles
 * target a *comfortable* allocation: the emulator runs well while the host
 * remains usable, with an explicit lightweight profile for 4 GB class hosts
 * (e.g. Dell Latitude 3190).
 */

const PROFILES: ResourceProfile[] = [
  {
    id: "lightweight",
    name: "Lightweight",
    description: "For 4 GB RAM hosts (e.g. Dell Latitude 3190). Leaves headroom for Windows and AEM Store.",
    ramMB: 1536,
    heapMB: 256,
    cores: 2,
    storageMB: 4096,
    gpuMode: "auto",
    snapshot: true,
    recommendedFor: "4 GB total RAM · dual-core or weaker CPU · limited disk",
  },
  {
    id: "balanced",
    name: "Balanced",
    description: "For 6–12 GB RAM hosts. The default comfortable configuration.",
    ramMB: 3072,
    heapMB: 512,
    cores: 4,
    storageMB: 8192,
    gpuMode: "auto",
    snapshot: true,
    recommendedFor: "6–12 GB total RAM · quad-core CPU · 20 GB+ free disk",
  },
  {
    id: "standard",
    name: "Standard",
    description: "For 12 GB+ RAM hosts. More emulator headroom while keeping Windows responsive.",
    ramMB: 4096,
    heapMB: 768,
    cores: 6,
    storageMB: 12288,
    gpuMode: "auto",
    snapshot: true,
    recommendedFor: "12 GB+ total RAM · 6+ cores · dedicated GPU",
  },
];

function getDiskFreeMB(dir: string): number | null {
  try {
    if (process.platform === "win32") {
      const drive = path.parse(dir).root || "C:";
      const out = execSync(`powershell -Command "(Get-PSDrive -Name '${drive[0]}').Free / 1MB"`, {
        encoding: "utf8",
        timeout: 5000,
      });
      const v = parseFloat(out.trim());
      if (!isNaN(v)) return Math.floor(v);
    } else {
      const out = execSync(`df -m "${dir}" | tail -1 | awk '{print $4}'`, {
        encoding: "utf8",
        timeout: 5000,
      });
      const v = parseInt(out.trim(), 10);
      if (!isNaN(v)) return v;
    }
  } catch {}
  return null;
}

export function evaluateHost(): HostResources {
  const cpus = os.cpus();
  const totalMemMB = Math.floor(os.totalmem() / 1024 / 1024);
  const freeMemMB = Math.floor(os.freemem() / 1024 / 1024);
  const diskFreeMB = getDiskFreeMB(os.homedir());

  let virtualizationEnabled: boolean | null = null;
  let hypervisor: string | null = null;
  let gpuInfo: string | null = null;

  if (process.platform === "win32") {
    try {
      const sysinfo = execSync("systeminfo", { encoding: "utf8", timeout: 8000 });
      virtualizationEnabled =
        /Virtualization Enabled In Firmware:\s*Yes/i.test(sysinfo) ||
        /Hyper-V.*?:\s*Yes/i.test(sysinfo) ||
        /Virtualization.*?:\s*Yes/i.test(sysinfo);
      if (/Windows Hypervisor Platform/i.test(sysinfo)) hypervisor = "WHPX";
      else if (/Hyper-V/i.test(sysinfo)) hypervisor = "Hyper-V";
      try {
        const haxm = execSync("sc query intelhaxm", { encoding: "utf8", timeout: 4000 });
        if (/RUNNING/i.test(haxm)) hypervisor = hypervisor ? hypervisor + " + HAXM" : "HAXM";
      } catch {}
      try {
        const g = execSync("wmic path win32_VideoController get name /format:list 2>nul", {
          encoding: "utf8",
          timeout: 5000,
        });
        const m = g.match(/Name=(.+)/);
        if (m) gpuInfo = m[1].trim();
      } catch {}
    } catch {}
  } else if (process.platform === "linux") {
    try {
      const cpuinfo = fsRead("/proc/cpuinfo");
      virtualizationEnabled = /vmx|svm/.test(cpuinfo ?? "");
      hypervisor = (cpuinfo ?? "").includes("/dev/kvm") || fs.existsSync("/dev/kvm") ? "KVM" : null;
    } catch {}
  } else if (process.platform === "darwin") {
    virtualizationEnabled = true;
    hypervisor = "Apple Hypervisor";
  }

  return {
    platform: process.platform,
    arch: process.arch,
    totalMemMB,
    freeMemMB,
    cpuModel: cpus[0]?.model || "Unknown",
    cpuCores: cpus.length || os.availableParallelism?.() || 4,
    diskFreeMB,
    virtualizationEnabled,
    hypervisor,
    gpuInfo,
    osVersion: `${os.type()} ${os.release()} ${os.arch()} | ${process.platform}`,
  };
}

function fsRead(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

/*
 * Choose a comfortable profile for this host.
 *
 * Rules (deliberately conservative — never max out the host):
 *  - total RAM < 6 GB   → lightweight  (4 GB class: Windows ~2 GB + browser + AEM Store must stay responsive)
 *  - total RAM 6–12 GB  → balanced
 *  - total RAM > 12 GB  → standard
 *  - free RAM < 2 GB right now → lightweight regardless of total
 *  - fewer than 4 cores → cap cores at 2, prefer lightweight
 *  - disk < 10 GB free → lightweight storage (4 GB) and flag limitation
 *  - virtualization unavailable → profile still reported, but emulator cannot run
 */
export function recommendProfile(host: HostResources): { profile: ResourceProfileId; reasons: string[]; limitations: string[] } {
  const reasons: string[] = [];
  const limitations: string[] = [];

  let id: ResourceProfileId = "balanced";

  if (host.totalMemMB < 6144 || host.freeMemMB < 2048) {
    id = "lightweight";
    reasons.push(
      `Low memory host: ${host.totalMemMB} MB total / ${host.freeMemMB} MB free — emulator limited to ${PROFILES[0].ramMB} MB so Windows stays responsive.`
    );
  } else if (host.totalMemMB >= 12288) {
    id = "standard";
    reasons.push(`Plentiful host memory (${host.totalMemMB} MB) — standard profile with ${PROFILES[2].ramMB} MB emulator RAM.`);
  } else {
    id = "balanced";
    reasons.push(`6–12 GB host RAM — balanced profile with ${PROFILES[1].ramMB} MB emulator RAM.`);
  }

  const profile = PROFILES.find(p => p.id === id)!;

  if (host.cpuCores < 4) {
    reasons.push(`Only ${host.cpuCores} CPU core(s) detected — emulator capped to 2 cores; expect slower boot and app performance.`);
    limitations.push("Dual-core host: emulator will be slow; consider physical device for day-to-day testing.");
  }

  if (host.diskFreeMB !== null && host.diskFreeMB < 10240) {
    limitations.push(`Only ${(host.diskFreeMB / 1024).toFixed(1)} GB free disk — SDK + AVD need ~10 GB. Free space before creating an AVD.`);
  }

  if (host.virtualizationEnabled === false) {
    limitations.push("CPU virtualization (VT-x/AMD-V) is not enabled — the emulator cannot start with hardware acceleration. Enable it in BIOS/UEFI and Windows Features.");
  } else if (host.virtualizationEnabled === null) {
    limitations.push("Could not determine virtualization state — diagnostics will confirm before start.");
  }

  if (!host.virtualizationEnabled && id !== "lightweight") {
    // still report the profile, but note it cannot run
  }

  if (process.platform !== "win32") {
    limitations.push(`Emulator on ${process.platform} is supported via the same SDK, but this build targets Windows desktop.`);
  }

  return { profile: id, reasons, limitations };
}

export function getResourceProfiles(): ResourceRecommendation {
  const host = evaluateHost();
  const { profile, reasons, limitations } = recommendProfile(host);
  return {
    host,
    profiles: PROFILES,
    recommended: profile,
    reasons,
    limitations,
  };
}

export function profileById(id: ResourceProfileId): ResourceProfile {
  return PROFILES.find(p => p.id === id) || PROFILES[1];
}

export function avdOptionsForProfile(id: ResourceProfileId, systemImage: string, avdName: string) {
  const p = profileById(id);
  return {
    name: avdName,
    systemImage,
    device: "pixel_7",
    ramMB: p.ramMB,
    heapMB: p.heapMB,
    cores: p.cores,
    storageMB: p.storageMB,
    gpuMode: p.gpuMode as GpuMode,
    snapshot: p.snapshot,
  } as const;
}
