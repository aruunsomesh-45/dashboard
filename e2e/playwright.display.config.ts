// Display checks: logged-in pages with mocked API responses (no backend contact).
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests-display",
  timeout: 60_000,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL || "http://localhost:3100",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium", viewport: { width: 1366, height: 900 } } }],
});
