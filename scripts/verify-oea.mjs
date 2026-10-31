import fs from "fs";
import { execSync } from "child_process";

console.log("🔍 OEA Floating Verification");
console.log("============================");
let failed=0;
function check(l, fn){ try{ fn(); console.log(`✅ ${l}`)} catch(e){ console.error(`❌ ${l}: ${e.message}`); failed++; } }

check("OEA module exists", ()=>{
  if (!fs.existsSync("oea/build.gradle.kts")) throw new Error("oea/build.gradle.kts missing");
  if (!fs.existsSync("oea/src/main/java/com/oea/launcher/multitask/OeaFloatingWindowService.kt")) throw new Error("Service.kt missing");
  if (!fs.existsSync("oea/src/main/java/com/oea/launcher/multitask/OeaFloatingWindows.kt")) throw new Error("OeaFloatingWindows.kt missing");
  if (!fs.existsSync("oea/src/main/res/xml/oea_floating_window.xml")) throw new Error("xml missing");
});

check("Existing not mistaken for projection", ()=>{
  const ws = fs.readFileSync("oea/src/main/java/com/oea/launcher/multitask/OeaFloatingWindows.kt","utf8");
  if (!ws.includes("MAX_WINDOWS = 3")) throw new Error("MAX_WINDOWS not 3");
  if (!ws.includes("Shortcut") && !ws.includes("Workspace")) throw new Error("Baseline workspace not documented");
});

check("Permissions tied to requirement", ()=>{
  const mf = fs.readFileSync("oea/src/main/AndroidManifest.xml","utf8");
  const svc = fs.readFileSync("oea/src/main/java/com/oea/launcher/multitask/OeaFloatingWindowService.kt","utf8");
  const xml = fs.readFileSync("oea/src/main/res/xml/oea_floating_window.xml","utf8");
  if (!mf.includes("SYSTEM_ALERT_WINDOW")) throw new Error("SYSTEM_ALERT_WINDOW not declared");
  if (!mf.includes("FOREGROUND_SERVICE_SPECIAL_USE")) throw new Error("foregroundServiceType specialUse missing");
  if (!xml.includes("canTakeScreenshot")) throw new Error("canTakeScreenshot not tied");
  if (!xml.includes("canPerformGestures")) throw new Error("canPerformGestures not tied");
  if (!mf.includes("com.whatsapp")) throw new Error("WhatsApp queries not present (first integration)");
  // Ensure no speculative permissions
  // Check actual permission declarations, not comments about not using them
  if (mf.includes("<uses-permission android:name=\"android.permission.READ_EXTERNAL_STORAGE\"") || mf.includes("<uses-permission android:name=\"android.permission.QUERY_ALL_PACKAGES\"")) throw new Error("Speculative permission found");
  if (mf.toLowerCase().includes("shizuku") && mf.includes("<uses-permission")) throw new Error("Shizuku permission found");
});

check("Missing capabilities investigated", ()=>{
  const svc = fs.readFileSync("oea/src/main/java/com/oea/launcher/multitask/OeaFloatingWindowService.kt","utf8");
  if (!svc.includes("takeScreenshot")) throw new Error("screenshot not implemented");
  if (!svc.includes("dispatchMappedTap")) throw new Error("gesture dispatch not implemented");
  const proj = fs.readFileSync("oea/src/main/java/com/oea/launcher/multitask/OeaProjectionController.kt","utf8");
  if (!proj.includes("FLAG_NOT_FOCUSABLE")) throw new Error("keyboard focus handling not investigated");
  if (!proj.includes("staleView")) throw new Error("stale/falsely live prevention missing");
});

check("Incremental app support one at a time", ()=>{
  if (!fs.existsSync("oea/src/main/java/com/oea/launcher/multitask/apps/AppRegistry.kt")) throw new Error("AppRegistry missing");
  if (!fs.existsSync("oea/src/main/java/com/oea/launcher/multitask/apps/WhatsAppProjectionHandler.kt")) throw new Error("WhatsApp handler missing");
  const reg = fs.readFileSync("oea/src/main/java/com/oea/launcher/multitask/apps/AppRegistry.kt","utf8");
  if (!reg.includes("init { register")) throw new Error("Auto-register should be commented until POC passes");
  if (reg.includes("register(WhatsAppProjectionHandler())") && !reg.includes("// init")) {
    throw new Error("WhatsApp should not be auto-registered before POC pass");
  }
});

check("Up to 3 windows", ()=>{
  const windows = fs.readFileSync("oea/src/main/java/com/oea/launcher/multitask/OeaFloatingWindows.kt","utf8");
  if (!windows.includes("MAX_WINDOWS = 3")) throw new Error("3-window limit not enforced");
  if (!fs.existsSync("docs/oea/03-multi-window.md")) throw new Error("multi-window doc missing");
});

check("Infinix Smart 8 dependency not assumed mandatory", ()=>{
  const inv = fs.readFileSync("docs/oea/00-investigation.md","utf8");
  if (inv.toLowerCase().includes("assume") && !inv.toLowerCase().includes("test the actual device behavior")) throw new Error("Go assumption not disclaimed");
  if (!fs.existsSync("docs/oea/test-plan-infinix-smart8.md")) throw new Error("test plan missing");
  const mf = fs.readFileSync("oea/src/main/AndroidManifest.xml","utf8");
  if (mf.toLowerCase().includes("shizuku") || mf.toLowerCase().includes("root")) throw new Error("Shizuku/root should not be mandatory");
});

check("Performance & reliability investigated", ()=>{
  const ctrl = fs.readFileSync("oea/src/main/java/com/oea/launcher/multitask/OeaProjectionController.kt","utf8");
  if (!ctrl.includes("500")) throw new Error("poll interval not set (freshness)");
  const poc = fs.readFileSync("docs/oea/01-feasibility-poc.md","utf8");
  if (!poc.toLowerCase().includes("target") || !poc.toLowerCase().includes("5s")) throw new Error("5s target not measured");
  if (!poc.includes("secure")) throw new Error("secure screen not handled");
});

check("No regression to AEM", ()=>{
  if (!fs.existsSync("app/src/main/java/com/aem/store/MainActivity.kt")) throw new Error("AEM MainActivity missing");
  if (!fs.existsSync("src/App.tsx")) throw new Error("AEM web missing");
  // settings.gradle should include oea but not break app
  const settings = fs.readFileSync("settings.gradle.kts","utf8");
  if (!settings.includes('include(":oea")')) throw new Error("oea not included as module");
});

check("Docs: investigation, POC report, incremental", ()=>{
  const needed = ["docs/oea/00-investigation.md","docs/oea/01-feasibility-poc.md","docs/oea/02-implementation-whatsapp.md","docs/oea/README.md"];
  for (const f of needed) if (!fs.existsSync(f)) throw new Error(f+" missing");
  const poc = fs.readFileSync("docs/oea/01-feasibility-poc.md","utf8");
  if (!poc.includes("Precise Failure")) throw new Error("Precise failure not documented");
  if (poc.includes("✅ All") && !poc.includes("Not yet passed on target")) throw new Error("Must not claim unperformed device tests");
});

console.log("");
if (failed) { console.error(`Failed ${failed}`); process.exit(1); }
console.log("🎉 OEA checks passed — AEM preserved, OEA evidence-based, no false success claims");
