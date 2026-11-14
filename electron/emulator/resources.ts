export interface ResourceInput {
  totalMemMB: number; freeMemMB: number; cpuCores: number;
  diskFreeMB?: number; acceleration: 'available' | 'unavailable' | 'unknown';
  arch: string; cpuBusyPercent?: number;
}
export interface ResourcePlan {
  supported: boolean; profile: 'lightweight' | 'balanced' | 'standard' | null;
  ramMB: number; cores: number; hostReserveMB: number; overheadMB: number;
  maxComfortableRamMB: number; reasons: string[]; warnings: string[];
}
/** Conservative engineering budgets, not benchmark claims. Android 34 image needs >=1536 MB guest RAM. */
export function recommendResources(h: ResourceInput): ResourcePlan {
  const reasons: string[] = [], warnings: string[] = [];
  const hostReserveMB = Math.max(2560, Math.ceil(h.totalMemMB * .25));
  const overheadMB = 768; // emulator process, graphics, startup/snapshot overhead, in addition to guest RAM
  const budget = Math.max(0, Math.floor(Math.min(h.totalMemMB - hostReserveMB - overheadMB, h.freeMemMB - 768 - overheadMB) / 256) * 256);
  if (![h.totalMemMB,h.freeMemMB,h.cpuCores].every(Number.isFinite) || h.freeMemMB > h.totalMemMB || h.cpuCores < 1) reasons.push('Invalid host resource measurements.');
  if (h.arch !== 'x64') reasons.push('The bundled Android x86_64 execution route requires an x64 host.');
  if (h.acceleration !== 'available') reasons.push(h.acceleration === 'unknown' ? 'Hardware acceleration is unverified. Install the SDK and run diagnostics; software emulation is not a comfortable fallback.' : 'Hardware acceleration is unavailable. Enable supported virtualization and hypervisor support.');
  if (h.diskFreeMB === undefined) reasons.push('Free storage could not be measured. Verify at least 20 GB before creating an emulator.');
  else if (h.diskFreeMB < 20480) reasons.push('At least 20 GB free storage is required for SDK, image, userdata and temporary files.');
  if (budget < 1536) reasons.push('Insufficient comfortable memory budget after reserving Windows/AEM and emulator overhead. Prefer phone execution or a native Windows variant.');
  if (h.cpuCores < 2) reasons.push('At least two logical CPU cores are required.');
  if (h.totalMemMB <= 4096) warnings.push('4 GB laptops such as the Latitude 3190 are not recommended for this Android 34 image; reducing guest RAM cannot remove OS, GPU and startup costs.');
  if ((h.cpuBusyPercent ?? 0) > 75) warnings.push('CPU is busy; close other workloads before starting.');
  if (h.cpuBusyPercent === undefined) warnings.push('Current CPU utilization is unknown; core count is not a performance benchmark.');
  const ramMB = budget >= 3072 ? 3072 : budget >= 2048 ? 2048 : budget >= 1536 ? 1536 : 0;
  const profile = ramMB === 3072 ? 'standard' : ramMB === 2048 ? 'balanced' : ramMB === 1536 ? 'lightweight' : null;
  const cores = Math.max(1, Math.min(4, Math.floor(h.cpuCores / 2)));
  if (ramMB === 1536) warnings.push('Lightweight is an experimental memory budget, not a validated performance profile. Heavy apps may fail.');
  return { supported: reasons.length === 0, profile, ramMB, cores, hostReserveMB, overheadMB, maxComfortableRamMB: budget, reasons, warnings };
}
export function validateAllocation(ramMB: number, cores: number, plan: ResourcePlan, hostCores: number) {
  if (!Number.isInteger(ramMB) || ramMB < 1536 || ramMB > plan.maxComfortableRamMB) throw new Error(`Guest RAM must be 1536–${plan.maxComfortableRamMB} MB at current host load`);
  if (!Number.isInteger(cores) || cores < 1 || cores > Math.max(1,hostCores-1)) throw new Error('Leave at least one host CPU core available');
}
