import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { AndroidRuntime } from "../desktop/runtime/service.mjs";
import { checkedCommand } from "../desktop/runtime/process.mjs";

const flags = new Set(process.argv.slice(2));
const root = path.resolve(process.env.AEM_RUNTIME_ROOT || ".aem-runtime/verification");
const reportFile = path.join(root, "verification-report.json");
const runtime = new AndroidRuntime({ root });
const report = { startedAt: new Date().toISOString(), platform: `${process.platform}/${process.arch}`, root, checks: [], success: false };
let server, started = false;
const record = (name, details = {}) => { const check = { name, passed: true, at: new Date().toISOString(), ...details }; report.checks.push(check); console.log(`PASS ${name}`, JSON.stringify(details)); };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(label, predicate, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await wait(1000); }
  throw new Error(`Timed out: ${label}`);
}
async function screenshot(file) {
  await new Promise((resolve, reject) => {
    const child = spawn(runtime.binary("adb"), ["-s", runtime.serial, "exec-out", "screencap", "-p"], { env: runtime.env(), shell: false });
    const output = createWriteStream(file); let error = "";
    child.stdout.pipe(output); child.stderr.on("data", (chunk) => { error += chunk; });
    child.on("error", reject); output.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`Screenshot failed: ${error}`)));
  });
}
try {
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("The release runtime verifier must run on Windows x64. Cross-platform unit tests are separate.");
  await runtime.initialize();
  if (!runtime.state.installed) {
    if (!flags.has("--accept-licenses")) throw new Error("Runtime is not installed. Review the Android SDK and Temurin licenses, then pass --accept-licenses to perform the real setup.");
    await runtime.setup({ acceptLicenses: true });
  }
  record("Licensed runtime installation", { installed: runtime.state.installed });
  report.diagnostics = await runtime.diagnostics();
  if (!report.diagnostics.acceleration.available) throw new Error(`No usable CPU virtualization. This is a failed runtime verification, not a successful build.\n${report.diagnostics.acceleration.output}`);
  record("CPU hardware acceleration", { output: report.diagnostics.acceleration.output });
  let networkHits = 0;
  server = http.createServer((request, response) => { if (request.url === "/probe") networkHits++; response.writeHead(200, { "Content-Type": "text/plain" }); response.end("aem-network-ok"); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(8765, "127.0.0.1", resolve); });
  await runtime.configure({ memoryMB: 2048, cores: 2, gpu: "software", camera: "off", microphone: false });
  const firstBoot = await runtime.start({ headless: true }); started = true;
  record("Genuine Android boot", { serial: firstBoot.serial, bootSeconds: firstBoot.bootSeconds });
  const properties = await runtime.adb(["shell", "getprop", "ro.build.version.release"]);
  const api = await runtime.adb(["shell", "getprop", "ro.build.version.sdk"]);
  if (api.stdout.trim() !== "35") throw new Error(`Expected API 35, got ${api.stdout.trim()}`);
  record("Android OS identity", { release: properties.stdout.trim(), api: api.stdout.trim() });
  const apk = path.join(root, "aem-runtime-probe.apk");
  await checkedCommand(process.env.PYTHON || "python", [path.resolve("scripts/build-test-apk.py"), "--sdk", runtime.sdkRoot, "--output", apk], { timeoutMs: 180000 });
  const bytes = await fs.readFile(apk);
  const metadata = await runtime.installApk(apk);
  if (metadata.packageName !== "com.aem.runtimeprobe") throw new Error("Wrong test APK identity.");
  record("Signed test APK installation", { package: metadata.packageName, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), signer: metadata.signingCertificateSha256 });
  await runtime.launchApp(metadata.packageName);
  await until("test Activity process", async () => (await runtime.adb(["shell", "pidof", metadata.packageName], { check: false })).code === 0);
  await until("Android app private storage", async () => (await runtime.adb(["shell", "run-as", metadata.packageName, "cat", "files/storage.txt"], { check: false })).stdout === "storage-ok");
  record("Application launch and private storage");
  await until("Guest-to-host NAT network", async () => (await runtime.adb(["shell", "run-as", metadata.packageName, "cat", "files/network.txt"], { check: false })).stdout === "network-ok");
  if (networkHits < 1) throw new Error("Guest reported network success without a host request.");
  record("Guest-to-host networking", { hostRequests: networkHits });
  await runtime.setPermission(metadata.packageName, "android.permission.CAMERA", true);
  if (!(await runtime.permissions(metadata.packageName)).find((p) => p.name === "android.permission.CAMERA")?.granted) throw new Error("Camera grant was not applied.");
  await runtime.adb(["shell", "am", "force-stop", metadata.packageName]);
  await runtime.launchApp(metadata.packageName);
  await until("Granted permission observed by app", async () => (await runtime.adb(["shell", "run-as", metadata.packageName, "cat", "files/camera-permission.txt"], { check: false })).stdout === "granted");
  await runtime.setPermission(metadata.packageName, "android.permission.CAMERA", false);
  if ((await runtime.permissions(metadata.packageName)).find((p) => p.name === "android.permission.CAMERA")?.granted) throw new Error("Camera revoke was not applied.");
  record("Android runtime permission grant and revoke");
  const hostFile = path.join(root, "host-probe.txt"); await fs.writeFile(hostFile, "AEM explicit file transfer probe\n");
  const pushed = await runtime.pushFile(hostFile);
  if (!(await runtime.listFiles()).includes(pushed.remotePath)) throw new Error("Pushed file missing from Android Downloads.");
  const pulled = path.join(root, "pulled-probe.txt"); await runtime.pullFile(pushed.remotePath, pulled);
  if (await fs.readFile(pulled, "utf8") !== "AEM explicit file transfer probe\n") throw new Error("File round trip changed content.");
  record("Explicit bidirectional file transfer");
  await runtime.reversePort(8765);
  const reverse = await runtime.adb(["reverse", "--list"]);
  if (!reverse.stdout.includes("tcp:8765")) throw new Error("ADB reverse port was not registered.");
  record("ADB development port forwarding");
  await wait(1500); await screenshot(path.join(root, "android-probe.png"));
  record("Real Android framebuffer screenshot", { file: "android-probe.png" });
  await runtime.stop(); started = false;
  await runtime.start({ headless: true }); started = true;
  if (!(await runtime.listApps()).some((app) => app.packageName === metadata.packageName)) throw new Error("Installed app did not survive a device restart.");
  const persisted = await runtime.adb(["shell", "run-as", metadata.packageName, "cat", "files/storage.txt"]);
  if (persisted.stdout !== "storage-ok") throw new Error("App storage did not survive a restart.");
  record("Installed app and storage persistence across restart");
  await runtime.uninstallApp(metadata.packageName);
  if ((await runtime.listApps()).some((app) => app.packageName === metadata.packageName)) throw new Error("App was not removed.");
  record("Android application uninstall");
  report.success = true;
} catch (error) {
  report.success = false; report.error = error.stack || String(error);
  console.error(error);
  process.exitCode = 1;
} finally {
  if (started) await runtime.stop().catch((error) => { report.error += `\nShutdown: ${error.message}`; });
  await runtime.dispose();
  if (server) await new Promise((resolve) => server.close(resolve));
  report.finishedAt = new Date().toISOString();
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(reportFile, JSON.stringify(report, null, 2) + "\n");
  console.log(`Verification report: ${reportFile}`);
}
