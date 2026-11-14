/**
 * Phone-powered desktop execution.
 *
 * AEM cannot control vendor desktop modes (e.g. Samsung DeX) and does not
 * assume every device supports desktop mode. The AEM-managed alternative is an
 * ADB + screen-mirroring session over the phone's ADB connection, gated behind
 * explicit user authorization (pairing). This module models the assessment and
 * the session contract; the mirroring/control runtime itself is not implemented
 * here and requires physical devices + ADB (not executable in this sandbox).
 */
export type PhoneSessionState =
  | "idle"
  | "discovering"
  | "authorized"
  | "mirroring"
  | "paused"
  | "ended"
  | "failed";

export interface PhoneDevice {
  id: string;
  name: string;
  model?: string;
  serial?: string;
  authorized: boolean;
  desktopModeCapable: boolean;
  lastSeenAt: string;
}

export interface PhoneSession {
  id: string;
  device: PhoneDevice;
  state: PhoneSessionState;
  startedAt?: string;
  endedAt?: string;
  error?: string;
}

export interface PhonePoweredAssessment {
  appId: string;
  available: boolean;
  score: number;
  reason: string;
  requirement?: string;
  desktopModeCapable: boolean;
  authorized: boolean;
}

const ANDROID_PLATFORM = "android";

/**
 * Assess whether an app can run phone-powered on the desktop. Pure in inputs.
 */
export function assessPhonePowered({
  app,
  desktopModeCapable,
  authorized,
}: {
  app: { id: { provider: string; project: string }; platforms: string[] };
  desktopModeCapable: boolean;
  authorized: boolean;
}): PhonePoweredAssessment {
  const appId = `${app.id.provider}/${app.id.project}`;
  const supportsAndroid = app.platforms.includes(ANDROID_PLATFORM);

  if (!desktopModeCapable) {
    return {
      appId,
      available: false,
      score: 0,
      reason: "Phone-powered desktop is not available on this device.",
      requirement: "Connect an Android phone with desktop mode / ADB debugging enabled.",
      desktopModeCapable: false,
      authorized: false,
    };
  }

  if (!supportsAndroid) {
    return {
      appId,
      available: false,
      score: 0,
      reason: "No Android-side component for this app to power the desktop.",
      requirement: "The app must ship an Android build.",
      desktopModeCapable: true,
      authorized,
    };
  }

  if (!authorized) {
    return {
      appId,
      available: false,
      score: 0,
      reason: "Phone not authorized for desktop control.",
      requirement: "Authorize the phone in Settings → Phone-powered desktop (pairing).",
      desktopModeCapable: true,
      authorized: false,
    };
  }

  return {
    appId,
    available: true,
    score: 70,
    reason: "Run from your Android phone and control it from the desktop.",
    desktopModeCapable: true,
    authorized: true,
  };
}
