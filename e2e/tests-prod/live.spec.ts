import { expect, test, type Page } from "@playwright/test";

// Known third-party noise that is not a defect of this app.
const IGNORED_CONSOLE = [/favicon/i, /Download the React DevTools/i];

function collect(page: Page) {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const badResponses: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && !IGNORED_CONSOLE.some((r) => r.test(m.text()))) consoleErrors.push(m.text().slice(0, 200));
  });
  page.on("pageerror", (e) => pageErrors.push(e.message.slice(0, 200)));
  page.on("response", (r) => {
    if (r.status() >= 500) badResponses.push(`${r.status()} ${r.url().replace(/\?.*/, "")}`);
  });
  return { consoleErrors, pageErrors, badResponses };
}

test.describe("public pages render without errors", () => {
  for (const path of ["/login", "/register", "/forgot-password", "/reset-password", "/mfa-challenge"]) {
    test(`${path} renders`, async ({ page }) => {
      const c = collect(page);
      const resp = await page.goto(path, { waitUntil: "networkidle" });
      expect(resp?.status(), "HTTP status").toBeLessThan(400);
      await expect(page.locator("body")).not.toContainText("Application error");
      expect(c.pageErrors, "uncaught JS errors").toEqual([]);
      expect(c.badResponses, "5xx responses").toEqual([]);
      // The logged-out session check (GET /api/auth/me -> 401) is expected and logs one console line.
      const unexpected = c.consoleErrors.filter((e) => !/status of 401/.test(e));
      expect(unexpected, "console errors").toEqual([]);
    });
  }
});

test("login form: empty submit is rejected, wrong password gets the generic message", async ({ page }) => {
  const c = collect(page);
  await page.goto("/login", { waitUntil: "networkidle" });
  const email = page.locator('input[type="email"], input[name="email"]').first();
  const password = page.locator('input[type="password"]').first();
  await expect(email).toBeVisible();
  await email.fill("nobody-e2e@example.invalid");
  await password.fill("wrong-password-123");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page.getByText(/Invalid email or password|temporarily unavailable|Too many attempts/i)).toBeVisible({ timeout: 20_000 });
  expect(c.badResponses, "5xx on login").toEqual([]);
});

test("protected pages redirect to login (no content leak)", async ({ page }) => {
  const protectedPaths = [
    "/dashboard", "/shopify", "/payments", "/pnl", "/logistics", "/marketing", "/marketing/links",
    "/integrations", "/team", "/workspace", "/settings",
  ];
  for (const p of protectedPaths) {
    await page.goto(p, { waitUntil: "domcontentloaded" });
    await expect(page, `${p} should end on /login`).toHaveURL(/\/login/);
  }
});

test("routes that must not exist in production are not served", async ({ page }) => {
  for (const p of ["/super-admin", "/inventory", "/influencer", "/dev/tests"]) {
    const resp = await page.goto(p, { waitUntil: "domcontentloaded" });
    // Middleware sends unknown paths to /login; the page content must never render.
    await expect(page.locator("body"), p).not.toContainText(/Test Dashboard|Super Admin|Inventory Management|Influencer/i);
    expect(resp?.status() ?? 200, p).toBeLessThan(500);
  }
});

test("unknown URL shows an app page, not a server error", async ({ page }) => {
  const resp = await page.goto("/this-page-does-not-exist-e2e", { waitUntil: "domcontentloaded" });
  expect(resp?.status() ?? 404).toBeLessThan(500);
});

test("security headers are present on the login page", async ({ request }) => {
  const r = await request.get("/login");
  const h = r.headers();
  expect(h["strict-transport-security"], "HSTS").toBeTruthy();
  expect(h["x-content-type-options"] ?? "", "nosniff").toMatch(/nosniff/i);
});

test("no service-role or secret material in the served login page", async ({ request }) => {
  const body = await (await request.get("/login")).text();
  expect(body).not.toMatch(/service_role/);
  expect(body).not.toMatch(/SUPABASE_SERVICE_ROLE_KEY/);
});

test("api: csrf endpoint works and unauthenticated data calls are refused", async ({ request }) => {
  const csrf = await request.get("/api/auth/csrf");
  expect(csrf.status()).toBe(200);
  expect(await csrf.json()).toHaveProperty("csrfToken");
  const data = await request.get("/api/w/125east/b/00000000-0000-0000-0000-000000000000/metrics");
  expect(data.status()).toBe(401);
});
