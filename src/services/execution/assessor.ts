import type { StoreApp } from "../../domain/catalog";
import type {
  ExecutionDecision,
  ExecutionHostInfo,
  ExecutionMethod,
} from "../../domain/execution";
import { assessExecution } from "../../domain/execution";
import { isDesktop, getDesktop } from "../emulator/contract";

/**
 * Resolve live host info from the desktop bridge (window.aemDesktop / electron)
 * and run the execution-method assessment for one application.
 *
 * Safe to call outside desktop: returns a desktop=false host info so every
 * method reports unavailable with clear requirements.
 */
export async function assessAppExecution(
  app: StoreApp,
): Promise<ExecutionDecision> {
  const desktop = getDesktop();
  const host: ExecutionHostInfo = {
    isDesktop: isDesktop(),
    emulatorAvailable: false,
    emulatorRunning: false,
    phonePoweredCapable: false,
    desktopModeCapable: false,
    phoneAuthorized: false,
  };

  if (desktop) {
    host.emulatorAvailable = !!(await desktop.emulator.getDiagnostics().catch(()=>null))?.summary.canRun;
    try {
      const st = await desktop.emulator.getStatus().catch(() => null);
      host.emulatorRunning = st?.state === "running";
    } catch {
      host.emulatorRunning = false;
    }
    // Phone-powered desktop is gated behind explicit authorization/ADB pairing.
    // AEM makes no assumption that desktop mode is supported or authorized.
    host.phonePoweredCapable = false;
    host.desktopModeCapable = false;
    host.phoneAuthorized = false;
  }

  // Host resource recommendation (advisory — influences emulator score only).
  try {
    const rec = await desktop?.emulator.getResourceProfiles?.().catch(() => null);
    host.recommendedProfileId = rec?.recommended ?? null;
    host.hostTotalMemMB = rec?.host.totalMemMB ?? null;
  } catch {
    host.recommendedProfileId = null;
    host.hostTotalMemMB = null;
  }

  return assessExecution(app, host);
}

/**
 * Synchronous, bridge-free assessment for previews / offline catalogs.
 * Use this when the desktop bridge isn't available yet.
 */
export function assessAppExecutionOffline(
  app: StoreApp,
  methodOverride?: Partial<ExecutionHostInfo>,
): ExecutionDecision {
  const host: ExecutionHostInfo = {
    isDesktop: typeof window !== "undefined" && !!(
      (window as any).aemDesktop || (window as any).electron
    ),
    emulatorAvailable: false,
    emulatorRunning: false,
    phonePoweredCapable: false,
    desktopModeCapable: false,
    phoneAuthorized: false,
    ...methodOverride,
  };
  return assessExecution(app, host);
}

export type { ExecutionMethod, ExecutionDecision, ExecutionHostInfo };
