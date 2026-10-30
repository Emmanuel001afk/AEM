import fs from "fs";
import path from "path";
import { execSync } from "child_process";

console.log("🔍 AEM Store Build Verification");
console.log("==============================");
let failed = 0;
function check(label, fn) {
  try { fn(); console.log(`✅ ${label}`); } catch(e) { console.error(`❌ ${label}: ${e.message}`); failed++; }
}
check("package.json has desktop identity", () => {
  const pkg = JSON.parse(fs.readFileSync("package.json","utf8"));
  if (pkg.build.appId !== "com.aem.store") throw new Error("appId missing");
  if (!pkg.build.win) throw new Error("win target missing");
  if (pkg.main !== "dist-electron/main.js") throw new Error("main missing");
});
check("Electron main process exists", () => {
  if (!fs.existsSync("electron/main.ts")) throw new Error("electron/main.ts missing");
  if (!fs.existsSync("electron/preload.ts")) throw new Error("electron/preload.ts missing");
});
check("Emulator integration exists", () => {
  const files = ["electron/emulator/manager.ts","electron/emulator/adb.ts","electron/emulator/sdk.ts","electron/emulator/diagnostics.ts","electron/emulator/instance.ts","electron/emulator/avd.ts"];
  for (const f of files) if (!fs.existsSync(f)) throw new Error(f+" missing");
});
check("Emulator UI exists", () => {
  if (!fs.existsSync("src/components/emulator/EmulatorView.tsx")) throw new Error("EmulatorView missing");
  if (!fs.existsSync("src/services/emulator/contract.ts")) throw new Error("emulator contract missing");
});
check("Renderer build configuration exists", () => {
  if (!fs.existsSync("vite.config.ts")) throw new Error("vite.config.ts missing");
});
check("Typecheck renderer", () => {
  execSync("npx tsc --noEmit", { stdio:"pipe", timeout:15000 });
});
check("Typecheck electron", () => {
  execSync("npx tsc --noEmit --project electron/tsconfig.json", { stdio:"pipe", timeout:15000 });
});
check("Vite build succeeds", () => {
  execSync("npx vite build", { stdio:"pipe", timeout:30000 });
  if (!fs.existsSync("dist/index.html")) throw new Error("dist/index.html not produced");
});
check("Electron build succeeds", () => {
  execSync("npx tsc --project electron/tsconfig.json", { stdio:"pipe", timeout:15000 });
  if (!fs.existsSync("dist-electron/main.js")) throw new Error("dist-electron/main.js not produced");
});
check("Electron output has the correct CommonJS module boundary", () => {
  const markerPath = path.join("dist-electron", "package.json");
  if (!fs.existsSync(markerPath)) throw new Error("dist-electron/package.json missing; run npm run build");
  const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
  if (marker.type !== "commonjs") throw new Error("dist-electron/package.json must declare type=commonjs");
  execSync("node --check dist-electron/main.js", { stdio:"pipe", timeout:15000 });
  execSync("node --check dist-electron/preload.js", { stdio:"pipe", timeout:15000 });
});
check("Icons exist", () => {
  if (!fs.existsSync("resources/icons/icon.png")) console.warn("⚠️ icon.png missing (will use default)");
});
check("Desktop docs exist", () => {
  if (!fs.existsSync("docs/desktop/README.md")) throw new Error("docs missing");
  if (!fs.existsSync("docs/emulator/README.md")) throw new Error("emulator docs missing");
});
console.log("");
if (failed) { console.error(`Verification failed: ${failed} checks`); process.exit(1); }
console.log("🎉 All verification checks passed");
