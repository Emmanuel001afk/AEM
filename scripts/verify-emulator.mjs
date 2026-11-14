import fs from "fs";
import path from "path";
console.log("AEM Emulator STATIC contract checks — NOT runtime or hardware acceptance");
console.log("=============================");
let failed=0;
function check(l,fn){ try{ fn(); console.log(`✅ ${l}`);} catch(e){ console.error(`❌ ${l}: ${e.message}`); failed++; } }
check("Emulator manager API", () => {
  const m = fs.readFileSync("electron/emulator/manager.ts","utf8");
  if (!m.includes("installApk")) throw new Error("installApk missing");
  if (!m.includes("start")) throw new Error("start missing");
  if (!m.includes("getDiagnostics")) throw new Error("diagnostics missing");
});
check("ADB wrapper", () => {
  const a = fs.readFileSync("electron/emulator/adb.ts","utf8");
  if (!a.includes("adbInstall")) throw new Error("adbInstall missing");
  if (!a.includes("adbLaunchApp")) throw new Error("launch missing");
});
check("Diagnostics", () => {
  const d = fs.readFileSync("electron/emulator/diagnostics.ts","utf8");
  if (!d.includes("virtualization")) throw new Error("virtualization check missing");
});
console.log("SKIPPED: SDK, boot, install, launch, GPU and resource benchmarks need actual runtime/device tests.");
check("Emulator UI includes required actions", () => {
  const ui = fs.readFileSync("src/components/emulator/EmulatorView.tsx","utf8");
  if (!ui.includes("Install APK")) throw new Error("Install APK button missing");
  if (!ui.includes("Diagnostics")) throw new Error("Diagnostics missing");
  if (!ui.includes("Launch")) throw new Error("Launch missing");
});
console.log("");
if (failed) { console.error(`Failed ${failed}`); process.exit(1); }
console.log("Static source checks passed (no emulator executed)");
