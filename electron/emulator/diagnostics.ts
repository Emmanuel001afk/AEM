import os from "os";
import fs from "fs";
import path from "path";
import { execSync, exec } from "child_process";
import { promisify } from "util";
import type { DiagnosticsResult, DiagnosticCheck, HostInfo, HostRequirements } from "./types";

const execAsync = promisify(exec);

const HOST_REQUIREMENTS: HostRequirements = {
  minRamMB: 4096,
  recommendedRamMB: 8192,
  minDiskMB: 10 * 1024,
  recommendedDiskMB: 20 * 1024,
  minCpuCores: 4,
  virtualizationRequired: true,
  hyperVModes: ["WHPX", "HAXM", "Hyper-V"],
  supportedGpuModes: ["auto", "host", "swiftshader_indirect", "angle"],
};

function checkSync(label: string, fn: () => Omit<DiagnosticCheck, "label">): DiagnosticCheck {
  try {
    const r = fn();
    return { label, ...r } as DiagnosticCheck;
  } catch (e: any) {
    return {
      label,
      id: label.toLowerCase().replace(/\s+/g, "_"),
      status: "fail",
      message: e?.message || String(e),
      required: true,
    };
  }
}

async function getDiskFreeMB(dir: string): Promise<number | undefined> {
  try {
    if (process.platform === "win32") {
      const drive = path.parse(dir).root || "C:";
      const out = execSync(`wmic logicaldisk where DeviceID="${drive.replace(/\\/g, "")}" get FreeSpace /value`, { encoding: "utf8", timeout: 5000 });
      const m = out.match(/FreeSpace=(\d+)/);
      if (m) return Math.floor(parseInt(m[1], 10) / 1024 / 1024);
      // fallback via powershell
      const ps = execSync(`powershell -Command "(Get-PSDrive -Name '${drive[0]}').Free / 1MB"`, { encoding: "utf8", timeout: 5000 });
      const v = parseFloat(ps.trim());
      if (!isNaN(v)) return Math.floor(v);
    } else {
      const out = execSync(`df -m "${dir}" | tail -1 | awk '{print $4}'`, { encoding: "utf8", timeout: 5000 });
      const v = parseInt(out.trim(), 10);
      if (!isNaN(v)) return v;
    }
  } catch {}
  return undefined;
}

function getCpuInfo(): { model: string; cores: number } {
  const cpus = os.cpus();
  return {
    model: cpus[0]?.model || "Unknown",
    cores: cpus.length || os.availableParallelism?.() || 4,
  };
}

async function detectVirtualizationWindows(): Promise<{ enabled: boolean; hypervisor?: string; details?: string }> {
  try {
    // Try systeminfo
    const sysinfo = execSync("systeminfo", { encoding: "utf8", timeout: 8000 });
    const hvLine = sysinfo.match(/Hyper-V.*?:\s*(.+)/i);
    const vmLine = sysinfo.match(/Virtualization.*?:\s*(.+)/i);
    const combined = (hvLine?.[1] || "") + " " + (vmLine?.[1] || "") + " " + sysinfo;
    const enabled = /yes/i.test(hvLine?.[1] || "") || /yes/i.test(vmLine?.[1] || "") || /Virtualization Enabled In Firmware:\s*Yes/i.test(sysinfo);
    let hypervisor: string | undefined;
    if (/WHPX|Windows Hypervisor Platform/i.test(sysinfo)) hypervisor = "WHPX";
    else if (/Hyper-V/i.test(sysinfo)) hypervisor = "Hyper-V";
    // Check HAXM via sc query
    try {
      const haxm = execSync("sc query intelhaxm", { encoding: "utf8", timeout: 4000 });
      if (/RUNNING/i.test(haxm)) hypervisor = hypervisor ? `${hypervisor} + HAXM` : "HAXM";
      else if (/STOPPED/i.test(haxm)) hypervisor = (hypervisor || "HAXM (stopped)");
    } catch {}
    // Check WHPX capability via emulator check
    try {
      const bcd = execSync("bcdedit /enum {current}", { encoding: "utf8", timeout: 3000 });
      if (/hypervisorlaunchtype\s+auto/i.test(bcd)) hypervisor = hypervisor || "Hyper-V (auto)";
    } catch {}
    return { enabled: enabled || !!hypervisor, hypervisor, details: (hvLine?.[0] || vmLine?.[0] || "").trim() || undefined };
  } catch (e: any) {
    return { enabled: false, details: e?.message };
  }
}

async function detectVirtualizationLinux(): Promise<{ enabled: boolean; hypervisor?: string; details?: string }> {
  try {
    const cpuinfo = fs.readFileSync("/proc/cpuinfo", "utf8");
    const hasVmx = /vmx/.test(cpuinfo);
    const hasSvm = /svm/.test(cpuinfo);
    const hasKvm = fs.existsSync("/dev/kvm");
    let enabled = hasVmx || hasSvm;
    let hypervisor: string | undefined;
    if (hasKvm) hypervisor = "KVM";
    if (hasVmx) hypervisor = hypervisor ? `${hypervisor}+VMX` : "VMX (Intel VT-x)";
    if (hasSvm) hypervisor = hypervisor ? `${hypervisor}+SVM` : "SVM (AMD-V)";
    return { enabled, hypervisor, details: `vmx=${hasVmx} svm=${hasSvm} kvm=${hasKvm}` };
  } catch {
    return { enabled: false };
  }
}

async function detectVirtualizationMac(): Promise<{ enabled: boolean; hypervisor?: string; details?: string }> {
  try {
    const out = execSync("sysctl -a | grep -E 'machdep.cpu.features|kern.hv'", { encoding: "utf8", timeout: 3000 });
    const hasVmx = /VMX/.test(out);
    const hv = /kern\.hv.*1/.test(out) ? "Hypervisor.Framework" : undefined;
    return { enabled: hasVmx, hypervisor: hv || (hasVmx ? "VMX" : undefined), details: out.slice(0, 200) };
  } catch {
    return { enabled: true, hypervisor: "Apple Hypervisor", details: "Assumed available on macOS 10.10+" };
  }
}

export async function runDiagnostics(userDataPath?: string): Promise<DiagnosticsResult> {
  const cpu = getCpuInfo();
  const totalMemMB = Math.floor(os.totalmem() / 1024 / 1024);
  const freeMemMB = Math.floor(os.freemem() / 1024 / 1024);
  const osVersion = `${os.type()} ${os.release()} ${os.arch()} | ${process.platform}`;
  const checks: DiagnosticCheck[] = [];

  const diskPath = userDataPath || os.homedir();
  const diskFreeMB = await getDiskFreeMB(diskPath);

  // Virtualization
  let virt: { enabled: boolean; hypervisor?: string; details?: string } = { enabled: false };
  if (process.platform === "win32") virt = await detectVirtualizationWindows();
  else if (process.platform === "linux") virt = await detectVirtualizationLinux();
  else if (process.platform === "darwin") virt = await detectVirtualizationMac();

  checks.push({
    id: "virtualization",
    label: "CPU Virtualization",
    status: virt.enabled ? "pass" : "fail",
    message: virt.enabled
      ? `Enabled${virt.hypervisor ? ` · ${virt.hypervisor}` : ""}`
      : "Disabled — emulator will be extremely slow or fail to start",
    details: virt.details,
    fix: virt.enabled
      ? undefined
      : "Enable Intel VT-x / AMD-V in BIOS/UEFI. On Windows, enable Hyper-V or Windows Hypervisor Platform in 'Turn Windows features on/off'. Restart required.",
    required: true,
  });

  // Hypervisor / WHPX on Windows
  if (process.platform === "win32") {
    const whpxOk = !!virt.hypervisor && /(WHPX|Hyper-V|HAXM)/i.test(virt.hypervisor);
    checks.push({
      id: "hypervisor",
      label: "Windows Hypervisor",
      status: whpxOk ? "pass" : virt.enabled ? "warn" : "fail",
      message: whpxOk
        ? `Active: ${virt.hypervisor}`
        : virt.enabled
        ? "Virtualization on, but no hypervisor detected — emulator may fall back to slow mode"
        : "No hypervisor — emulator cannot use hardware acceleration",
      fix: whpxOk ? undefined : "Enable 'Windows Hypervisor Platform' and 'Hyper-V' in Windows Features. For Intel without Hyper-V, install HAXM from https://github.com/intel/haxm",
      required: false,
    });
  }

  // RAM
  checks.push({
    id: "ram",
    label: "System Memory",
    status: totalMemMB >= HOST_REQUIREMENTS.recommendedRamMB ? "pass" : totalMemMB >= HOST_REQUIREMENTS.minRamMB ? "warn" : "fail",
    message: `${totalMemMB} MB total · ${freeMemMB} MB free${totalMemMB < HOST_REQUIREMENTS.minRamMB ? " — below minimum 4 GB" : totalMemMB < HOST_REQUIREMENTS.recommendedRamMB ? " — 8 GB+ recommended for smooth emulation" : ""}`,
    fix: totalMemMB < HOST_REQUIREMENTS.minRamMB ? "Close other applications or increase system RAM. Emulator needs at least 3 GB free." : undefined,
    required: true,
  });

  // Disk
  if (diskFreeMB !== undefined) {
    checks.push({
      id: "disk",
      label: "Disk Space",
      status: diskFreeMB >= HOST_REQUIREMENTS.recommendedDiskMB ? "pass" : diskFreeMB >= HOST_REQUIREMENTS.minDiskMB ? "warn" : "fail",
      message: `${(diskFreeMB / 1024).toFixed(1)} GB free at ${diskPath}${diskFreeMB < HOST_REQUIREMENTS.minDiskMB ? " — insufficient for AVD + SDK" : ""}`,
      fix: diskFreeMB < HOST_REQUIREMENTS.minDiskMB ? "Free disk space: emulator + system image needs ~10 GB, 20 GB recommended." : undefined,
      required: true,
    });
  } else {
    checks.push({
      id: "disk",
      label: "Disk Space",
      status: "info",
      message: "Could not determine free disk — ensure at least 10 GB free",
      required: false,
    });
  }

  // CPU cores
  checks.push({
    id: "cpu",
    label: "CPU Cores",
    status: cpu.cores >= 8 ? "pass" : cpu.cores >= HOST_REQUIREMENTS.minCpuCores ? "warn" : "fail",
    message: `${cpu.cores} cores · ${cpu.model.slice(0, 80)}`,
    fix: cpu.cores < HOST_REQUIREMENTS.minCpuCores ? "Quad-core CPU recommended. Emulator will be slow on dual-core." : undefined,
    required: false,
  });

  // GPU / OpenGL
  let gpuInfo: string | undefined;
  try {
    if (process.platform === "win32") {
      const g = execSync("wmic path win32_VideoController get name,AdapterRAM /format:list 2>nul | head -20", { encoding: "utf8", timeout: 5000 });
      gpuInfo = g.trim().slice(0, 500) || undefined;
    } else if (process.platform === "linux") {
      const g = execSync("lspci | grep -i vga || lshw -C display 2>/dev/null | head -20", { encoding: "utf8", timeout: 5000 });
      gpuInfo = g.trim().slice(0, 500) || undefined;
    } else if (process.platform === "darwin") {
      const g = execSync("system_profiler SPDisplaysDataType 2>/dev/null | head -30", { encoding: "utf8", timeout: 5000 });
      gpuInfo = g.trim().slice(0, 500) || undefined;
    }
  } catch {}
  checks.push({
    id: "gpu",
    label: "Graphics Acceleration",
    status: gpuInfo ? "pass" : "info",
    message: gpuInfo ? `Detected: ${gpuInfo.split("\n")[0]?.slice(0, 80)}` : "GPU info unavailable — emulator will try host GPU and fallback to SwiftShader",
    details: gpuInfo,
    fix: undefined,
    required: false,
  });

  // OS version check (Windows)
  if (process.platform === "win32") {
    const rel = os.release(); // e.g. 10.0.22621
    const major = parseInt(rel.split(".")[0] || "0", 10);
    checks.push({
      id: "os",
      label: "Operating System",
      status: major >= 10 ? "pass" : "fail",
      message: `Windows ${rel} — ${major >= 10 ? "Supported" : "Windows 10 64-bit or newer required"}`,
      fix: major < 10 ? "Upgrade to Windows 10 2004+ or Windows 11 for WHPX/Hyper-V support." : undefined,
      required: true,
    });
  }

  // Hyper-V launch type on Windows (extra)
  if (process.platform === "win32") {
    try {
      const bcd = execSync('bcdedit /enum {current} 2>nul | findstr hypervisorlaunchtype', { encoding: "utf8", timeout: 3000 });
      checks.push({
        id: "hypervisor_launch",
        label: "Hypervisor Launch Type",
        status: /auto/i.test(bcd) ? "pass" : "info",
        message: bcd.trim() || "Unknown — run 'bcdedit' as admin to check",
        fix: /off/i.test(bcd) ? "Run as admin: bcdedit /set hypervisorlaunchtype auto and reboot to enable WHPX." : undefined,
        required: false,
      });
    } catch {
      // silent
    }
  }

  // Summary
  const passed = checks.filter(c => c.status === "pass").length;
  const warnings = checks.filter(c => c.status === "warn").length;
  const failed = checks.filter(c => c.status === "fail").length;
  const requiredFailed = checks.filter(c => c.status === "fail" && c.required).length;
  const canRun = requiredFailed === 0;

  const host: HostInfo = {
    totalMemMB,
    freeMemMB,
    cpuModel: cpu.model,
    cpuCores: cpu.cores,
    gpuInfo,
    osVersion,
    virtualizationEnabled: virt.enabled,
    hypervisor: virt.hypervisor,
    diskFreeMB,
  };

  return {
    timestamp: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    checks,
    summary: { passed, warnings, failed, canRun },
    requirements: HOST_REQUIREMENTS,
    host,
  };
}

export function formatDiagnosticsMarkdown(d: DiagnosticsResult): string {
  const lines: string[] = [
    `# Host Diagnostics — ${new Date(d.timestamp).toLocaleString()}`,
    ``,
    `- Platform: ${d.platform} ${d.arch}`,
    `- OS: ${d.host.osVersion}`,
    `- CPU: ${d.host.cpuModel} (${d.host.cpuCores} cores)`,
    `- RAM: ${d.host.totalMemMB} MB total / ${d.host.freeMemMB} MB free`,
    `- Disk free: ${d.host.diskFreeMB ? (d.host.diskFreeMB / 1024).toFixed(1) + " GB" : "unknown"}`,
    `- Virtualization: ${d.host.virtualizationEnabled ? "Enabled" : "Disabled"}${d.host.hypervisor ? ` (${d.host.hypervisor})` : ""}`,
    `- Can run emulator: ${d.summary.canRun ? "YES" : "NO"} (pass ${d.summary.passed}, warn ${d.summary.warnings}, fail ${d.summary.failed})`,
    ``,
    `## Checks`,
  ];
  for (const c of d.checks) {
    const icon = c.status === "pass" ? "✅" : c.status === "fail" ? "❌" : c.status === "warn" ? "⚠️" : "ℹ️";
    lines.push(`- ${icon} **${c.label}** — ${c.message}`);
    if (c.details) lines.push(`  - Details: ${c.details.slice(0, 300)}`);
    if (c.fix) lines.push(`  - Fix: ${c.fix}`);
  }
  return lines.join("\n");
}
