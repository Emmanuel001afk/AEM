import os from "node:os";

export const PACKAGE_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z][a-zA-Z0-9_]*)+$/;
export const MANAGEABLE_PERMISSIONS = Object.freeze(new Set([
  "READ_CONTACTS", "WRITE_CONTACTS", "GET_ACCOUNTS", "READ_CALENDAR", "WRITE_CALENDAR",
  "READ_PHONE_STATE", "READ_PHONE_NUMBERS", "CALL_PHONE", "ANSWER_PHONE_CALLS", "ADD_VOICEMAIL",
  "USE_SIP", "ACCEPT_HANDOVER", "BODY_SENSORS", "BODY_SENSORS_BACKGROUND", "ACTIVITY_RECOGNITION",
  "ACCESS_FINE_LOCATION", "ACCESS_COARSE_LOCATION", "ACCESS_BACKGROUND_LOCATION", "ACCESS_MEDIA_LOCATION",
  "RECORD_AUDIO", "CAMERA", "READ_MEDIA_IMAGES", "READ_MEDIA_VIDEO", "READ_MEDIA_AUDIO",
  "READ_MEDIA_VISUAL_USER_SELECTED", "READ_EXTERNAL_STORAGE", "WRITE_EXTERNAL_STORAGE",
  "READ_CALL_LOG", "WRITE_CALL_LOG", "PROCESS_OUTGOING_CALLS", "SEND_SMS", "RECEIVE_SMS",
  "READ_SMS", "RECEIVE_WAP_PUSH", "RECEIVE_MMS", "POST_NOTIFICATIONS", "NEARBY_WIFI_DEVICES",
  "BLUETOOTH_SCAN", "BLUETOOTH_CONNECT", "BLUETOOTH_ADVERTISE", "UWB_RANGING",
].map((name) => `android.permission.${name}`)));

export function assertPackage(value) {
  if (typeof value !== "string" || value.length > 200 || !PACKAGE_PATTERN.test(value)) {
    throw new Error("Invalid Android package identity.");
  }
  return value;
}
export function assertPermission(value) {
  if (!MANAGEABLE_PERMISSIONS.has(value)) throw new Error("This permission cannot be changed by AEM. Open Android Settings instead.");
  return value;
}
export function defaultSettings() {
  const cores = os.cpus().length || 2;
  const halfMemory = Math.floor(os.totalmem() / 1024 / 1024 / 2);
  return {
    cores: Math.max(1, Math.min(4, Math.floor(cores / 2))),
    memoryMB: Math.max(1024, Math.min(3072, Math.floor(halfMemory / 512) * 512)),
    diskGB: 8, gpu: "auto", camera: "off", microphone: false,
  };
}
export function validateSettings(input, host = { cores: os.cpus().length, memoryMB: Math.floor(os.totalmem() / 1024 / 1024) }) {
  const previous = defaultSettings();
  const value = { ...previous, ...input };
  for (const key of ["cores", "memoryMB", "diskGB"]) {
    if (!Number.isInteger(value[key])) throw new Error(`${key} must be a whole number.`);
  }
  if (value.cores < 1 || value.cores > Math.min(8, host.cores)) throw new Error(`Choose between 1 and ${Math.min(8, host.cores)} CPU cores.`);
  if (value.memoryMB < 1024 || value.memoryMB > Math.min(8192, Math.floor(host.memoryMB / 2)) || value.memoryMB % 256 !== 0) {
    throw new Error(`Choose 1024–${Math.min(8192, Math.floor(host.memoryMB / 2))} MB of RAM, in steps of 256 MB. AEM reserves half of host RAM.`);
  }
  if (value.diskGB < 4 || value.diskGB > 64) throw new Error("Virtual disk size must be between 4 and 64 GB.");
  if (!["auto", "host", "software"].includes(value.gpu)) throw new Error("Unknown graphics mode.");
  if (!["off", "webcam0"].includes(value.camera)) throw new Error("Unknown camera mode.");
  if (typeof value.microphone !== "boolean") throw new Error("Microphone must be on or off.");
  return { cores: value.cores, memoryMB: value.memoryMB, diskGB: value.diskGB, gpu: value.gpu, camera: value.camera, microphone: value.microphone };
}

export function parseBadging(text) {
  const pkg = text.match(/^package:\s*name='([^']+)'.*?versionCode='(\d+)'.*?versionName='([^']*)'/m);
  if (!pkg) throw new Error("Android could not read this APK's package identity and version.");
  const label = text.match(/^application-label(?:-en-US|-en)?:'([^']*)'/m)?.[1];
  const sdk = text.match(/^sdkVersion:'(\d+)'/m)?.[1];
  const target = text.match(/^targetSdkVersion:'(\d+)'/m)?.[1];
  const native = [...text.matchAll(/^native-code:\s*(.*)$/gm)].flatMap((m) => m[1].match(/'([^']+)'/g)?.map((x) => x.slice(1, -1)) || []);
  return {
    packageName: assertPackage(pkg[1]), versionCode: Number(pkg[2]), versionName: pkg[3],
    label: label || pkg[1], minSdk: sdk ? Number(sdk) : 1, targetSdk: target ? Number(target) : undefined,
    nativeCode: native,
    armOnly: native.length > 0 && !native.some((x) => ["x86", "x86_64"].includes(x)),
  };
}
export function parseSigningCertificate(text) {
  const cert = text.match(/Signer #1 certificate SHA-256 digest:\s*([a-f0-9]{64})/i)?.[1];
  if (!cert) throw new Error("APK signature has no readable SHA-256 certificate identity.");
  return cert.toLowerCase();
}
export function parsePermissions(text) {
  const requested = text.match(/^\s*requested permissions:\s*\n([\s\S]*?)(?=\n\s*\n|\n\s*[a-zA-Z][^\n]*permissions?:)/m)?.[1] || "";
  const names = [...requested.matchAll(/^\s*(android\.permission\.[A-Z_]+)/gm)].map((m) => m[1]);
  const states = new Map([...text.matchAll(/^\s*(android\.permission\.[A-Z_]+): granted=(true|false)/gm)].map((m) => [m[1], m[2] === "true"]));
  return [...new Set(names)].filter((name) => MANAGEABLE_PERMISSIONS.has(name)).map((name) => ({ name, granted: states.get(name) === true, manageable: true }));
}
export function parseInstalledPackage(text, packageName) {
  return {
    packageName,
    versionName: text.match(/\bversionName=(\S+)/)?.[1] || "Unknown",
    versionCode: Number(text.match(/\b(?:longVersionCode|versionCode)=(\d+)/)?.[1] || 0),
    enabled: !/enabled=3\b/.test(text),
  };
}
export function mergeAvdConfig(existing, settings) {
  const changes = {
    "hw.ramSize": String(settings.memoryMB), "vm.heapSize": "256", "hw.cpu.ncount": String(settings.cores),
    "disk.dataPartition.size": `${settings.diskGB}G`, "hw.lcd.width": "720", "hw.lcd.height": "1280",
    "hw.lcd.density": "320", "hw.keyboard": "yes", "hw.gpu.enabled": "yes",
    "hw.gpu.mode": settings.gpu === "software" ? "swiftshader_indirect" : settings.gpu,
    "hw.camera.back": settings.camera === "off" ? "none" : settings.camera,
    "hw.camera.front": "none", "hw.audioInput": settings.microphone ? "yes" : "no", "hw.audioOutput": "yes",
    "PlayStore.enabled": "false", "showDeviceFrame": "yes", "fastboot.forceColdBoot": "yes",
  };
  const lines = existing.split(/\r?\n/).filter((line) => line.trim() && !(line.split("=")[0].trim() in changes));
  return [...lines, ...Object.entries(changes).map(([key, value]) => `${key}=${value}`)].join("\n") + "\n";
}
export function emulatorArgs(settings, { port, headless = false }) {
  const args = ["-avd", "AEM_Phone", "-port", String(port), "-accel", "on", "-no-snapshot-save", "-no-boot-anim",
    "-gpu", settings.gpu === "software" ? "swiftshader_indirect" : settings.gpu,
    "-camera-back", settings.camera === "off" ? "none" : settings.camera, "-camera-front", "none"];
  if (headless) args.push("-no-window", "-no-audio");
  // Microphone sharing is controlled by hw.audioInput; do not disable Android audio output with it.
  return args;
}
export function accelerationResult(result) {
  const output = `${result.stdout}\n${result.stderr}`.trim();
  return { available: result.code === 0 && /is installed and usable|is available and usable|is installed and usable\./i.test(output), output: output.slice(-4000) };
}
export function guestPath(value) {
  if (typeof value !== "string" || value.length > 500 || !value.startsWith("/sdcard/Download/AEM/") || /[\x00-\x1f\\]/.test(value) || value.split("/").includes("..")) {
    throw new Error("Files can only be exchanged inside /sdcard/Download/AEM.");
  }
  return value;
}
export function safeFilename(value) {
  const name = String(value).split(/[\\/]/).pop().replace(/[\x00-\x1f<>:"|?*]/g, "_").replace(/^\.+/, "").trim();
  if (!name || name === "." || name === "..") throw new Error("Invalid filename.");
  return name.slice(0, 160);
}
