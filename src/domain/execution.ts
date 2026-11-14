import type { Application, Artifact, Platform } from "./model";
import type { StoreApp } from "./catalog";
import { assessNativeWindows, cannotConvertNote } from "./nativeWindows";
import { assessPhonePowered } from "./phonePowered";

/**
 * The three ways AEM Store can run an application.
 * - emulator: run the Android APK inside the integrated local Android emulator (Windows desktop).
 * - native-windows: run a native Windows build (EXE/MSIX) of the same application.
 * - phone-powered: run via the user's Android phone (desktop control / screen mirroring over ADB).
 */
export type ExecutionMethod = "emulator" | "native-windows" | "phone-powered";

export const ALL_EXECUTION_METHODS: ExecutionMethod[] = [
  "emulator",
  "native-windows",
  "phone-powered",
];

export const METHOD_LABEL: Record<ExecutionMethod, string> = {
  emulator: "Android emulator",
  "native-windows": "Native Windows",
  "phone-powered": "Phone-powered desktop",
};

export interface ExecutionCompatibility {
  method: ExecutionMethod;
  available: boolean;
  score: number; // 0-100, higher = better fit for this host
  reason: string; // human-readable explanation
  requirement?: string; // what must change to make this method available
}

export interface ExecutionDecision {
  appId: string;
  recommended: ExecutionMethod | null;
  alternatives: ExecutionMethod[];
  assessments: ExecutionCompatibility[];
  summary: string;
}

export interface ExecutionHostInfo {
  isDesktop: boolean;
  emulatorAvailable: boolean;
  emulatorRunning: boolean;
  recommendedProfileId?: "lightweight" | "balanced" | "standard" | null;
  hostTotalMemMB?: number | null;
  phonePoweredCapable: boolean;
  desktopModeCapable: boolean;
  phoneAuthorized: boolean;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

const ANDROID_INSTALLABLE_KINDS = new Set(["apk", "apks", "xapk", "apkm"]);

function hasInstallableAndroidArtifact(release: StoreApp["latest"]): boolean {
  if (!release) return false;
  return release.artifacts.some(
    (a: Artifact) =>
      a.platform === "android" && ANDROID_INSTALLABLE_KINDS.has(String(a.kind).toLowerCase()),
  );
}

function hasWindowsArtifact(app: Application): boolean {
  if (!app.platforms.includes("windows")) return false;
  const release = (app as any).latest;
  if (!release) return false;
  return release.artifacts.some(
    (a: Artifact) =>
      (a.platform === "windows" || a.platform === "android") &&
      (String(a.kind).toLowerCase() === "exe" || String(a.kind).toLowerCase() === "msix"),
  );
}

/**
 * Assess which execution methods are available for one application on the
 * current host, pick a recommendation, and produce a human-readable summary.
 *
 * Pure in its inputs: pass resolved host info so it stays testable without
 * Electron / window. The UI layer resolves `isDesktop`, emulator state and
 * host resources from the desktop bridge and passes them in.
 */
export function assessExecution(
  app: StoreApp,
  host: ExecutionHostInfo,
): ExecutionDecision {
  const id = `${app.id.provider}/${app.id.project}`;
  const androidArtifact = hasInstallableAndroidArtifact((app as any).latest);
  const windowsArtifact = hasWindowsArtifact(app);

  const assessments: ExecutionCompatibility[] = [];

  // --- emulator -----------------------------------------------------
  const emulatorAvailable =
    host.isDesktop && host.emulatorAvailable && androidArtifact;
  let emulatorScore = 0;
  let emulatorReason = "";
  let emulatorReq: string | undefined;
  if (!host.isDesktop) {
    emulatorReason = "Emulator only runs on the Windows desktop build.";
    emulatorReq = "Install AEM Store for Windows.";
  } else if (!host.emulatorAvailable) {
    emulatorReason = "Emulator bridge is not available.";
    emulatorReq = "Start AEM Store desktop and open the Emulator tab.";
  } else if (!androidArtifact) {
    emulatorReason = "No installable Android package (APK/APKS/XAPK/APKM) for this release.";
    emulatorReq = "Publish an Android artifact for this app.";
  } else if (!host.emulatorRunning) {
    emulatorScore = 60;
    emulatorReason = "Android APK available — start the emulator, then install.";
    emulatorReq = "Start the emulator from the Emulator tab.";
  } else {
    emulatorScore = 90;
    emulatorReason =
      "Android APK available and emulator is running — install and launch.";
  }
  assessments.push({
    method: "emulator",
    available: emulatorAvailable,
    score: emulatorScore,
    reason: emulatorReason,
    ...(emulatorReq ? { requirement: emulatorReq } : {}),
  });

  // --- native windows -----------------------------------------------
  const native = assessNativeWindows(app as any);
  const nativeAvailable = native.variant.available;
  const nativeScore = native.variant.available ? 95 : 0;
  assessments.push({
    method: "native-windows",
    available: nativeAvailable,
    score: nativeScore,
    reason: native.summary,
    ...(native.variant.cannotConvertReason
      ? { requirement: native.variant.cannotConvertReason }
      : {}),
  });

  // --- phone-powered ------------------------------------------------
  const phone = assessPhonePowered({
    app,
    desktopModeCapable: host.desktopModeCapable,
    authorized: host.phoneAuthorized,
  });
  const phoneCapable = phone.available;
  assessments.push({
    method: "phone-powered",
    available: phoneCapable,
    score: phone.score,
    reason: phone.reason,
    ...(phone.requirement ? { requirement: phone.requirement } : {}),
  });

  // --- recommendation -----------------------------------------------
  const available = assessments.filter((a) => a.available);
  available.sort((a, b) => b.score - a.score);
  const recommended = available[0]?.method ?? null;
  const alternatives = available
    .filter((a) => a.method !== recommended)
    .map((a) => a.method);

  let summary = "";
  if (!recommended) {
    summary = "No execution method is available for this app on this host.";
  } else if (recommended === "emulator") {
    summary =
      host.emulatorRunning
        ? "Recommended: install and run in the Android emulator."
        : "Recommended: Android emulator — start it first, then install.";
  } else if (recommended === "native-windows") {
    summary = "Recommended: run the native Windows build directly.";
  } else {
    summary = "Recommended: run from your Android phone on the desktop.";
  }

  return { appId: id, recommended, alternatives, assessments, summary };
}

/**
 * Friendly one-line explanation of why a method is unavailable, for UI.
 */
export function unavailabilityNote(a: ExecutionCompatibility): string | null {
  if (a.available) return null;
  return a.requirement ? `${a.reason} (${a.requirement})` : a.reason;
}

export type { Platform };
