import type { DesktopBridge, EmulatorBridge } from "./contract";
import { getDesktop, isDesktop } from "./contract";

export function requireDesktop(): DesktopBridge {
  const d = getDesktop();
  if (!d) throw new Error("AEM Store desktop features are only available in the Windows desktop app. Download the installer from GitHub Releases.");
  return d;
}

export function tryGetEmulator(): EmulatorBridge | null {
  return getDesktop()?.emulator || null;
}

export function isEmulatorAvailable(): boolean {
  return isDesktop() && !!getDesktop()?.emulator;
}

// Re-export helpers for UI
export { isDesktop, getDesktop };
