import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { assertPackage, assertPermission, validateSettings, parseBadging, parseSigningCertificate, parsePermissions, parseInstalledPackage, mergeAvdConfig, emulatorArgs, accelerationResult, guestPath, safeFilename } from "../../desktop/runtime/validation.mjs";
import { extractZip, runCommand, downloadFile } from "../../desktop/runtime/process.mjs";
import { AndroidRuntime } from "../../desktop/runtime/service.mjs";
import { compareAndroidRelease } from "../../src/domain/version.ts";
import { filterCatalog } from "../../src/domain/catalog.ts";

const badging = `package: name='com.example.test' versionCode='42' versionName='1.2.3'\nsdkVersion:'26'\ntargetSdkVersion:'35'\napplication-label:'Example'\nnative-code: 'arm64-v8a'\n`;
test("APK metadata retains deterministic package, version, SDK and ABI boundaries", () => {
  const apk = parseBadging(badging);
  assert.equal(apk.packageName, "com.example.test"); assert.equal(apk.versionCode, 42); assert.equal(apk.minSdk, 26); assert.equal(apk.armOnly, true);
  assert.equal(parseBadging(badging.replace("arm64-v8a", "x86_64")).armOnly, false);
  assert.throws(() => parseBadging("not an apk"), /package identity/);
});
test("APK signer identity is parsed, not inferred from a filename", () => {
  const hash = "a".repeat(64);
  assert.equal(parseSigningCertificate(`Signer #1 certificate SHA-256 digest: ${hash}\n`), hash);
  assert.throws(() => parseSigningCertificate("DOES NOT VERIFY"), /certificate identity/);
});
test("package and permission inputs cannot become shell commands", () => {
  assert.equal(assertPackage("com.example.app"), "com.example.app");
  for (const value of ["com.example;calc", "com.example.app && id", "com.example/../../x", "a".repeat(201)]) assert.throws(() => assertPackage(value));
  assert.equal(assertPermission("android.permission.CAMERA"), "android.permission.CAMERA");
  assert.throws(() => assertPermission("android.permission.INSTALL_PACKAGES"));
  assert.throws(() => assertPermission("android.permission.CAMERA; id"));
});
test("resource settings enforce host limits and explicit hardware consent", () => {
  const host = { cores: 8, memoryMB: 16384 };
  assert.equal(validateSettings({ cores: 4, memoryMB: 3072 }, host).memoryMB, 3072);
  assert.throws(() => validateSettings({ cores: 9 }, host));
  assert.throws(() => validateSettings({ memoryMB: 12288 }, host));
  assert.throws(() => validateSettings({ memoryMB: 1025 }, host));
  assert.throws(() => validateSettings({ diskGB: 128 }, host));
  assert.throws(() => validateSettings({ gpu: "arbitrary" }, host));
  assert.throws(() => validateSettings({ microphone: "yes" }, host));
});
test("runtime permissions reflect actual Android grant state", () => {
  const permissions = parsePermissions(`    requested permissions:\n      android.permission.CAMERA\n      android.permission.INTERNET\n      android.permission.RECORD_AUDIO\n    install permissions:\n      android.permission.INTERNET: granted=true\n    runtime permissions:\n      android.permission.CAMERA: granted=true, flags=[ USER_SET ]\n      android.permission.RECORD_AUDIO: granted=false\n`);
  assert.deepEqual(permissions, [{ name: "android.permission.CAMERA", granted: true, manageable: true }, { name: "android.permission.RECORD_AUDIO", granted: false, manageable: true }]);
});
test("installed package version parsing handles modern long version codes", () => {
  assert.deepEqual(parseInstalledPackage("versionCode=42 minSdk=26 targetSdk=35\nversionName=1.2.3\nlongVersionCode=42\nenabled=0", "com.example.test"), { packageName: "com.example.test", versionName: "1.2.3", versionCode: 42, enabled: true });
});
test("AVD config preserves unrelated settings and never enables Play Store", () => {
  const config = mergeAvdConfig("custom.user=keep\nhw.ramSize=1024\n", validateSettings({ memoryMB: 2048, diskGB: 12, camera: "off", microphone: false }, { cores: 8, memoryMB: 16384 }));
  assert.match(config, /custom.user=keep/); assert.match(config, /hw.ramSize=2048/); assert.equal((config.match(/hw.ramSize=/g) || []).length, 1);
  assert.match(config, /disk.dataPartition.size=12G/); assert.match(config, /PlayStore.enabled=false/); assert.match(config, /hw.camera.back=none/); assert.match(config, /hw.audioInput=no/);
});
test("emulator requires CPU acceleration and exposes only explicit hardware options", () => {
  const settings = validateSettings({ gpu: "software", camera: "webcam0", microphone: true }, { cores: 8, memoryMB: 16384 });
  const args = emulatorArgs(settings, { port: 5556 });
  assert.ok(args.includes("on")); assert.ok(args.includes("swiftshader_indirect")); assert.ok(args.includes("webcam0")); assert.ok(!args.includes("-no-audio"));
  const headless = emulatorArgs(settings, { port: 5556, headless: true }); assert.ok(headless.includes("-no-window")); assert.ok(!headless.includes("-no-accel"));
  const mutedMic = emulatorArgs(validateSettings({ microphone: false }, { cores: 8, memoryMB: 16384 }), { port: 5556 }); assert.ok(!mutedMic.includes("-no-audio"));
});
test("acceleration is not considered available merely because a command ran", () => {
  assert.equal(accelerationResult({ code: 0, stdout: "accel:\n0\nWHPX(10.0.26100) is installed and usable.\naccel", stderr: "" }).available, true);
  assert.equal(accelerationResult({ code: 0, stdout: "WHPX is not installed", stderr: "" }).available, false);
  assert.equal(accelerationResult({ code: 1, stdout: "WHPX is installed and usable", stderr: "" }).available, false);
});
test("guest file access is restricted and filenames are sanitized", () => {
  assert.equal(guestPath("/sdcard/Download/AEM/test.txt"), "/sdcard/Download/AEM/test.txt");
  for (const file of ["/data/data/com.example/databases/secret", "/sdcard/Download/AEM/../../secret"]) assert.throws(() => guestPath(file));
  assert.equal(safeFilename("..\\..\\test:file.txt"), "test_file.txt");
});
test("process arguments are passed literally without a shell", async () => {
  const result = await runCommand(process.execPath, ["-e", "console.log(process.argv[1])", "hello; $(do-not-execute)"]);
  assert.equal(result.code, 0); assert.equal(result.stdout.trim(), "hello; $(do-not-execute)");
});
test("runtime downloads reject non-official hosts before network access", async () => {
  await assert.rejects(downloadFile("https://example.com/runtime.zip", path.join(os.tmpdir(), "unused-aem.zip")), /Untrusted runtime download host/);
  await assert.rejects(downloadFile("file:///etc/passwd", path.join(os.tmpdir(), "unused-aem.zip")), /Untrusted runtime download host/);
});

function crc32(buffer) { let crc = 0xffffffff; for (const byte of buffer) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); } return (crc ^ 0xffffffff) >>> 0; }
function zip(entries) {
  const local = [], central = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), data = Buffer.from(entry.data || ""), crc = crc32(data);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x0800, 6); header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, data);
    const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x0800, 8); directory.writeUInt32LE(((entry.mode || 0x8000) << 16) >>> 0, 38); directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(data.length, 20); directory.writeUInt32LE(data.length, 24); directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(offset, 42);
    central.push(directory, name); offset += header.length + name.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
test("zip extraction accepts regular files and rejects traversal and symlinks", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aem-zip-"));
  try {
    const good = path.join(root, "good.zip"); await fs.writeFile(good, zip([{ name: "tool/bin/file.txt", data: "safe" }]));
    await extractZip(good, path.join(root, "out")); assert.equal(await fs.readFile(path.join(root, "out/tool/bin/file.txt"), "utf8"), "safe");
    for (const [index, entry] of [{ name: "../escape.txt", data: "bad" }, { name: "link", data: "/etc/passwd", mode: 0xa000 }].entries()) {
      const archive = path.join(root, `bad-${index}.zip`); await fs.writeFile(archive, zip([entry]));
      await assert.rejects(extractZip(archive, path.join(root, `bad-out-${index}`)), /Unsafe archive entry|invalid relative path/);
    }
    await assert.rejects(fs.access(path.join(root, "escape.txt")));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test("runtime refuses unlicensed setup and device commands while stopped", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aem-runtime-"));
  const runtime = new AndroidRuntime({ root, platform: "win32", arch: "x64" });
  try {
    await runtime.initialize();
    await assert.rejects(runtime.setup({ acceptLicenses: false }), /licenses/);
    await assert.rejects(runtime.listApps(), /Start Android/);
    await assert.rejects(runtime.start(), /Install the Android runtime/);
    await assert.rejects(runtime.installCatalog({ url: "https://example.com/app.apk", sha256: "a".repeat(64) }), /SHA-256|AEM artifact/);
    assert.equal(runtime.snapshot().installed, false);
  } finally { await runtime.dispose(); await fs.rm(root, { recursive: true, force: true }); }
});
test("existing store identity and version rules remain intact", () => {
  const artifact = { id: "1", platform: "android", kind: "apk", filename: "app.apk", downloadUrl: "https://example.com", packageIdentity: "com.example.app", versionCode: 5, signingCertificateSha256: "a".repeat(64) };
  const release = { id: "r", applicationId: { provider: "github", project: "example/app" }, version: { name: "5", code: 5 }, channel: "stable", status: "published", sourceReleaseId: "r", artifacts: [artifact] };
  const installed = { packageIdentity: "com.example.app", versionName: "4", versionCode: 4, signingCertificateSha256: "a".repeat(64) };
  assert.equal(compareAndroidRelease(release, installed), "update-available");
  assert.equal(compareAndroidRelease(release, { ...installed, signingCertificateSha256: "b".repeat(64) }), "identity-mismatch");
  assert.equal(compareAndroidRelease(release, { ...installed, versionCode: 6 }), "local-newer");
  const app = { id: { provider: "github", project: "example/app" }, name: "Example", category: "Tools", functionality: ["Testing"], screenshots: [], permissions: [], platforms: ["android"] };
  assert.equal(filterCatalog([app], { query: "testing" }).length, 1); assert.equal(filterCatalog([app], { query: "missing" }).length, 0);
});
