import { defineConfig } from "@playwright/test";

/**
 * Desktop-only e2e suite for 125east frontend.
 * Targets an ISOLATED stack (frontend :3100 -> backend copy :8001), never the dev DB.
 * Supabase network calls are fully mocked in tests/helpers.ts (no calls to the hosted project).
 */
export default defineConfig({
  testDir: "./tests",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["json", { outputFile: "results/results.json" }]],
  outputDir: "results/artifacts",
  use: {
    baseURL: process.env.E2E_BASE_URL || "http://localhost:3100",
    channel: "chrome",
    headless: true,
    viewport: { width: 1440, height: 900 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    ignoreHTTPSErrors: true,
  },
});
