// Browser checks against the LIVE site. No accounts, no writes: logged-out behaviour only.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests-prod",
  timeout: 60_000,
  retries: 1,
  reporter: [["list"], ["json", { outputFile: "results-prod/report.json" }]],
  use: {
    baseURL: process.env.E2E_BASE_URL || "https://125east.vercel.app",
    trace: "off",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium", viewport: { width: 1366, height: 800 } } }],
});
