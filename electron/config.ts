import path from "path";
import { app } from "electron";

export const IS_DEV = !app.isPackaged;
export const IS_WINDOWS = process.platform === "win32";
export const IS_MAC = process.platform === "darwin";
export const IS_LINUX = process.platform === "linux";

export function getUserDataPath(): string {
  return app.getPath("userData");
}

export function getSdkRoot(): string {
  return path.join(getUserDataPath(), "android-sdk");
}

export function getEmulatorDataRoot(): string {
  return path.join(getUserDataPath(), "emulator");
}

export function getAvdRoot(): string {
  // AVDs are stored in userData/emulator/avd to avoid polluting ~/.android
  return path.join(getEmulatorDataRoot(), "avd");
}

export function getEmulatorHome(): string {
  return path.join(getEmulatorDataRoot(), "home");
}

export function getDownloadsRoot(): string {
  return path.join(getUserDataPath(), "downloads");
}

export function getLogsRoot(): string {
  return path.join(getUserDataPath(), "logs");
}

export const DEFAULT_AVD_NAME = "aem_pixel_7";
export const DEFAULT_SYSTEM_IMAGE = "system-images;android-34;google_apis;x86_64";
export const DEFAULT_DEVICE_PROFILE = "pixel_7";
export const DEFAULT_RAM_MB = 3072;
export const DEFAULT_CORES = 4;
export const DEFAULT_HEAP_MB = 512;
export const DEFAULT_STORAGE_MB = 8192;
export const DEFAULT_API_LEVEL = 34;

// Download URLs — version-pinned, with fallbacks handled in sdk.ts
export const SDK_URLS = {
  win: {
    cmdlineTools: "https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip",
    platformTools: "https://dl.google.com/android/repository/platform-tools-latest-windows.zip",
    emulator: "https://dl.google.com/android/repository/emulator-windows_x64-12207491.zip",
  },
  mac: {
    cmdlineTools: "https://dl.google.com/android/repository/commandlinetools-mac-11076708_latest.zip",
    platformTools: "https://dl.google.com/android/repository/platform-tools-latest-darwin.zip",
    emulator: "https://dl.google.com/android/repository/emulator-darwin_aarch64-12207491.zip",
  },
  linux: {
    cmdlineTools: "https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip",
    platformTools: "https://dl.google.com/android/repository/platform-tools-latest-linux.zip",
    emulator: "https://dl.google.com/android/repository/emulator-linux_x64-12207491.zip",
  },
};

export const EMULATOR_FLAGS = {
  defaults: [
    "-no-snapshot-save",
    // Use host GPU when available; fallback to swiftshader_indirect is automatic
    "-gpu", "auto",
  ],
  // cold boot explicitly requested via UI
  coldBoot: ["-no-snapshot-load", "-no-snapshot-save"],
  snapshot: ["-snapshot", "default_boot"],
};

export const ADB_CONNECT_TIMEOUT_MS = 120_000;
export const EMULATOR_BOOT_TIMEOUT_MS = 180_000;
