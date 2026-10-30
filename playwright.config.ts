import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/desktop",
  timeout: 60000,
  expect: { timeout: 15000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }], ["json", { outputFile: "test-results/results.json" }]],
  use: { trace: "retain-on-failure", screenshot: "only-on-failure" },
});
