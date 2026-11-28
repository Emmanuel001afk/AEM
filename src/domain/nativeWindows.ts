/**
 * Native Windows delivery framework.
 *
 * Models whether an application can run as a native Windows build (EXE/MSIX)
 * rather than through the Android emulator. AEM does not promise that every
 * Android app can become native Windows — apps without source/components are
 * explicitly reported as "cannot convert" instead of implying a conversion
 * path that does not exist.
 */
export type NativeBuildStrategy =
  | "source-rebuild"     // app ships Windows source/components; rebuild to EXE/MSIX
  | "published-native"   // separately published Windows artifact; not APK conversion
  | "unavailable";       // no native Windows build possible from available inputs

export interface NativeWindowsVariant {
  available: boolean;
  strategy: NativeBuildStrategy;
  artifactKind?: "exe" | "msix";
  sourceAvailable: boolean;
  identityMapping?: string; // how the Windows identity maps to the Android package identity
  cannotConvertReason?: string; // populated when available === false and no build is possible
}

export interface NativeWindowsAssessment {
  appId: string;
  variant: NativeWindowsVariant;
  summary: string;
}

const WINDOWS_ARTIFACT_KINDS = new Set(["exe"]);

/**
 * Assess the native-Windows delivery option for one application based on its
 * published artifacts and declared platforms. Pure in its inputs.
 */
export function assessNativeWindows(app: {
  id: { provider: string; project: string };
  platforms: string[];
  latest?: { artifacts: Array<{ platform: string; kind: string; packageIdentity?: string;sha256?:string;downloadUrl?:string }> };
  windowsLatest?: { artifacts: Array<{ platform: string; kind: string; packageIdentity?: string;sha256?:string;downloadUrl?:string }> };
  packageIdentity?: string;
}): NativeWindowsAssessment {
  const appId = `${app.id.provider}/${app.id.project}`;
  const hasWindowsPlatform = app.platforms.includes("windows");

  const windowsArtifacts = (app.windowsLatest?.artifacts || app.latest?.artifacts || []).filter(
    (a) => a.platform === "windows" && WINDOWS_ARTIFACT_KINDS.has(String(a.kind).toLowerCase()) && !!a.packageIdentity && /^[a-f0-9]{64}$/i.test(a.sha256||'') && /^https:\/\//.test(a.downloadUrl||''),
  );

  const variant: NativeWindowsVariant = {
    available: false,
    strategy: "unavailable",
    sourceAvailable: false,
  };

  if (!hasWindowsPlatform && !windowsArtifacts.length) {
    variant.cannotConvertReason =
      "Application does not declare a Windows platform — no native Windows build is published.";
    return {
      appId,
      variant,
      summary: "Native Windows is not available for this application.",
    };
  }

  if (!windowsArtifacts.length) {
    variant.cannotConvertReason =
      "Windows platform is declared but no EXE/MSIX artifact has been published. A native Windows build must be authored and published; it cannot be derived automatically from the Android APK.";
    return {
      appId,
      variant,
      summary:
        "Windows platform declared but no native Windows artifact published — cannot convert without a published Windows build.",
    };
  }

  const artifact = windowsArtifacts[0];
  variant.available = true;
  variant.strategy = "published-native";
  variant.artifactKind =
    String(artifact.kind).toLowerCase() === "msix" ? "msix" : "exe";
  variant.identityMapping = artifact.packageIdentity || app.packageIdentity;
  variant.sourceAvailable = false; // source availability is declared at publish time

  return {
    appId,
    variant,
    summary:
      `Native Windows build available (${variant.artifactKind.toUpperCase()}) — install and run directly, no emulator required.`,
  };
}

/**
 * Human-friendly one-line note when native Windows is unavailable.
 */
export function cannotConvertNote(v: NativeWindowsVariant): string | null {
  if (v.available) return null;
  return v.cannotConvertReason ?? "No native Windows build is available for this application.";
}
