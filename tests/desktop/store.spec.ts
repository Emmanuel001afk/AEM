import { test, expect, _electron as electron } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

let application: ElectronApplication, page: Page, root: string;
test.beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "aem-desktop-test-"));
  const executablePath = process.env.AEM_TEST_EXECUTABLE;
  application = await electron.launch({ timeout: 20000, executablePath: executablePath || undefined, args: executablePath ? ["--disable-gpu"] : [".", "--disable-gpu"], env: { ...process.env, AEM_RUNTIME_ROOT: root, AEM_DEV_SERVER: "", AEM_E2E: "1" } });
  page = await application.firstWindow();
  await page.route("https://*.supabase.co/**", async (route) => {
    const url = new URL(route.request().url());
    let body: unknown = [];
    if (url.pathname.endsWith("/applications")) body = [{ id: 1, provider: "github", project: "example/phormi", package_identity: "com.example.phormi", name: "Phormi", description: "A browser for testing.", source_url: "https://github.com/example/phormi", platforms: ["android"], category: "Browsers", functionality: ["Web browsing"], screenshots: [], permissions: ["Internet"], releases: [{ id: 10, version_name: "2.0", version_code: 2, channel: "stable", status: "published", title: "Phormi 2", published_at: "2026-10-01T00:00:00Z", source_release_id: "r2", artifacts: [{ id: 100, platform: "android", kind: "apk", filename: "phormi.apk", download_url: "https://wfvvmyixqcwosmuldxoq.supabase.co/storage/v1/object/public/aem-artifacts/phormi.apk", size_bytes: 2048, sha256: "a".repeat(64), package_identity: "com.example.phormi", signing_certificate_sha256: "b".repeat(64), version_code: 2, signing_status: "ready" }] }] }];
    await route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*" }, body: JSON.stringify(body) });
  });
  // Install deterministic network fixtures before the renderer's first catalog request.
  const rendererErrors: string[] = [];
  page.on("pageerror", (error) => rendererErrors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") rendererErrors.push(message.text()); });
  await page.evaluate(() => { setTimeout(() => window.location.reload(), 0); });
  try { await expect(page.getByRole("heading", { name: "Phormi", exact: true })).toBeVisible({ timeout: 20000 }); }
  catch (error) {
    const state = await page.evaluate(() => ({ url: location.href, title: document.title, text: document.body?.innerText?.slice(0, 3000), secure: window.isSecureContext, uuid: typeof crypto.randomUUID, bridge: typeof window.aemDesktop }));
    throw new Error(`Catalog fixture did not render: ${JSON.stringify({ state, rendererErrors })}\n${error}`);
  }
});
test.afterEach(async () => { await application?.close(); if (root) await fs.rm(root, { recursive: true, force: true }); });

test("installed Windows identity, existing discovery, filters and app details work", async () => {
  await expect(page).toHaveTitle("AEM Software Store");
  const info = await page.evaluate(() => window.aemDesktop!.getAppInfo());
  expect(info.platform).toBe("win32"); expect(info.arch).toBe("x64");
  if (process.env.AEM_TEST_EXECUTABLE) expect(info.packaged).toBe(true);
  await page.getByRole("textbox", { name: "Search applications" }).fill("not-present");
  await expect(page.getByRole("heading", { name: "Phormi", exact: true })).toHaveCount(0);
  await page.getByRole("textbox", { name: "Search applications" }).fill("browser");
  await page.getByRole("heading", { name: "Phormi", exact: true }).click();
  await page.locator("details.version-pocket summary").click();
  await expect(page.getByText("com.example.phormi", { exact: false })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Permissions", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "← Back to Apps" }).click();
  await page.getByRole("button", { name: "Updates", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Available releases" })).toBeVisible();
});
test("Android is an honest integrated runtime, not a placeholder device", async () => {
  await page.getByRole("button", { name: "Emulator", exact: true }).click();
  await expect(page.getByRole("heading", { name: "AEM Android", exact: true })).toBeVisible();
  await expect(page.getByText("SETUP REQUIRED", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Start Android", exact: true })).toBeDisabled();
  const download = page.getByRole("button", { name: "Download & install Android" });
  await expect(download).toBeDisabled();
  await page.getByRole("checkbox", { name: /I accept the Android SDK license/ }).check();
  await expect(download).toBeEnabled(); // Consent is tested; CI's runtime verifier performs the actual large download.
  for (const tab of ["Applications", "Permissions", "Files", "Diagnostics"]) {
    await page.getByRole("tab", { name: tab, exact: true }).click();
    await expect(page.getByRole("tabpanel")).toBeVisible();
  }
  await expect(page.getByRole("button", { name: "Run checks", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Run checks", exact: true }).click();
  await expect(page.getByText("CPU virtualization", { exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("aem-android-diagnostics.png"), fullPage: true });
});
test("renderer is sandboxed and the native bridge rejects non-HTTPS external links", async () => {
  const isolation = await page.evaluate(() => ({ nodeRequire: typeof (window as any).require, nodeProcess: typeof (window as any).process, bridge: typeof window.aemDesktop?.getState }));
  expect(isolation).toEqual({ nodeRequire: "undefined", nodeProcess: "undefined", bridge: "function" });
  await expect(page.evaluate(() => window.aemDesktop!.openExternal("javascript:alert(1)"))).rejects.toThrow(/HTTPS/);
  const traversal = await page.evaluate(async () => (await fetch("aem://store/%2e%2e%2fpackage.json")).status);
  expect([400, 403, 404]).toContain(traversal);
  await page.evaluate(() => window.open("https://example.com", "_blank"));
  await expect.poll(() => page.url()).toMatch(/^aem:\/\/store\//);
});
test("new Android interface has no serious accessibility violations", async () => {
  await page.getByRole("button", { name: "Emulator", exact: true }).click();
  await expect(page.getByRole("heading", { name: "AEM Android", exact: true })).toBeVisible();
  const require = createRequire(import.meta.url);
  const axeSource = await fs.readFile(require.resolve("axe-core/axe.min.js"), "utf8");
  await page.evaluate(axeSource);
  const results = await page.evaluate(async () => (window as any).axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] } }));
  const serious = results.violations.filter((v: any) => ["serious", "critical"].includes(v.impact || ""));
  await test.info().attach("accessibility", { body: JSON.stringify(serious, null, 2), contentType: "application/json" });
  expect(serious).toEqual([]);
});
