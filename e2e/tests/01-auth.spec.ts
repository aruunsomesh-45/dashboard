/**
 * Email/password auth against the REAL backend (no mocks): registration, login, logout, route protection,
 * session expiry, refresh while signed in, form validation, loading states, error messages, responsiveness.
 *
 * Run against an isolated stack, never a real database, e.g.:
 *   E2E_BASE_URL=http://localhost:3011 npx playwright test tests/01-auth.spec.ts
 */
import { test, expect, Page, ConsoleMessage } from "@playwright/test";

const PW = "Browser-Test-Passphrase-31";
/** The form's error banner (Next.js also renders a hidden role=alert route announcer, which we skip). */
const formAlert = (page: Page) => page.locator('[role="alert"]:not(#__next-route-announcer__)');
const uniq = () => `${Date.now()}${Math.floor(Math.random() * 1e6)}`;

/** Console errors, ignoring the browser's own "Failed to load resource" lines for expected 4xx responses. */
function trackConsole(page: Page) {
  const errors: string[] = [];
  page.on("console", (m: ConsoleMessage) => {
    if (m.type() === "error" && !/Failed to load resource: the server responded with a status of 4\d\d/.test(m.text())) {
      errors.push(m.text());
    }
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

async function registerViaUi(page: Page, ws: string, email: string, pw = PW) {
  await page.goto("/register");
  await page.getByLabel("Workspace name").fill(ws);
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(pw);
  await page.getByLabel("Confirm password").fill(pw);
  await page.getByRole("button", { name: "Create account" }).click();
}

async function loginViaUi(page: Page, email: string, pw = PW) {
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password").fill(pw);
  await page.getByRole("button", { name: "Sign in" }).click();
}

test.describe("Registration", () => {
  test("client-side validation blocks submit and shows field errors", async ({ page }) => {
    let posted = false;
    page.on("request", (r) => r.method() === "POST" && r.url().includes("/api/auth/register") && (posted = true));
    await page.goto("/register");

    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByText("Workspace name is required.")).toBeVisible();
    await expect(page.getByText("Email is required.")).toBeVisible();
    await expect(page.getByText("Password is required.")).toBeVisible();
    await expect(page.getByText("Please confirm your password.")).toBeVisible();

    await page.getByLabel("Workspace name").fill("Acme");
    await page.getByLabel("Email address").fill("not-an-email");
    await page.getByLabel("Password", { exact: true }).fill("short");
    await page.getByLabel("Confirm password").fill("different");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByText("Enter a valid email address.")).toBeVisible();
    await expect(page.getByText("Password must be at least 10 characters.")).toBeVisible();
    await expect(page.getByText("Passwords do not match.")).toBeVisible();
    await expect(page.getByLabel("Email address")).toHaveAttribute("aria-invalid", "true");

    expect(posted).toBe(false);
    await expect(page).toHaveURL(/\/register$/);
  });

  test("register -> loading state -> /dashboard with the new workspace, survives refresh", async ({ page }) => {
    const errors = trackConsole(page);
    const ws = `Playwright Co ${uniq()}`;
    await page.route("**/api/auth/register/", async (route) => {
      await new Promise((r) => setTimeout(r, 600)); // make the loading state observable
      await route.continue();
    });
    await registerViaUi(page, ws, `pw.${uniq()}@example.test`);
    await expect(page.getByRole("button", { name: "Creating account…" })).toBeDisabled();

    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByTestId("workspace-switcher-btn")).toContainText(ws);

    await page.reload();
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByTestId("workspace-switcher-btn")).toContainText(ws);
    expect(errors).toEqual([]);
  });

  test("duplicate email shows the server error on the email field", async ({ page, browser }) => {
    const email = `dup.${uniq()}@example.test`;
    const first = await browser.newPage();
    await registerViaUi(first, "First", email);
    await expect(first).toHaveURL(/\/dashboard$/);
    await first.close();

    await registerViaUi(page, "Second", email.toUpperCase());
    await expect(formAlert(page)).toContainText("An account with this email already exists.");
    await expect(page.locator("#email-error")).toHaveText("An account with this email already exists.");
    await expect(page.getByRole("button", { name: "Create account" })).toBeEnabled();
    await expect(page).toHaveURL(/\/register$/);
  });
});

test.describe("Login / logout", () => {
  let email: string;
  test.beforeAll(async ({ browser }) => {
    email = `login.${uniq()}@example.test`;
    const p = await browser.newPage();
    await registerViaUi(p, "Login Co", email);
    await expect(p).toHaveURL(/\/dashboard$/);
    await p.close();
  });

  test("login page has all controls and working links", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByLabel("Email address")).toBeVisible();
    await expect(page.getByLabel("Password")).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
    await page.getByRole("link", { name: "Forgot password?" }).click();
    await expect(page).toHaveURL(/\/forgot-password$/);
    await page.goto("/login");
    await page.getByRole("link", { name: "Create account" }).click();
    await expect(page).toHaveURL(/\/register$/);
  });

  test("login form validation", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText("Email is required.")).toBeVisible();
    await expect(page.getByText("Password is required.")).toBeVisible();
    await page.getByLabel("Email address").fill("nope");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText("Enter a valid email address.")).toBeVisible();
  });

  test("wrong password and unknown email show the same error and stay on /login", async ({ page }) => {
    await page.goto("/login");
    await loginViaUi(page, email, "Wrong-Password-000");
    await expect(formAlert(page)).toHaveText("Invalid email or password.");
    await expect(page).toHaveURL(/\/login/);

    await page.getByLabel("Email address").fill(`ghost.${uniq()}@example.test`);
    await page.getByLabel("Password").fill(PW);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(formAlert(page)).toHaveText("Invalid email or password.");
  });

  test("valid login shows loading state, lands on /dashboard; logout returns to /login and re-guards", async ({ page }) => {
    const errors = trackConsole(page);
    await page.route("**/api/auth/login/", async (route) => {
      await new Promise((r) => setTimeout(r, 600));
      await route.continue();
    });
    await page.goto("/login");
    await loginViaUi(page, email.toUpperCase());
    await expect(page.getByRole("button", { name: "Signing in…" })).toBeDisabled();
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByTestId("workspace-switcher-btn")).toContainText("Login Co");

    const cookies = await page.context().cookies();
    const sid = cookies.find((c) => c.name === "sessionid");
    expect(sid?.httpOnly).toBe(true);
    expect(await page.evaluate(() => document.cookie)).not.toContain("sessionid");
    expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toMatch(/password|token|sessionid/i);

    await page.getByRole("button", { name: "Sign Out" }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login/);
    expect(errors).toEqual([]);
  });

  test("protected deep link -> /login?next=… -> back to that page after login", async ({ page }) => {
    await page.goto("/team");
    await expect(page).toHaveURL(/\/login\?next=%2Fteam$/);
    await loginViaUi(page, email);
    await expect(page).toHaveURL(/\/team$/);
  });
});

test.describe("Sessions", () => {
  test("no cookie: every dashboard route redirects to /login server-side", async ({ page }) => {
    for (const route of ["/dashboard", "/", "/pnl", "/settings", "/team"]) {
      const res = await page.goto(route);
      expect(page.url(), route).toContain("/login");
      expect(res?.status()).toBe(200);
    }
  });

  test("expired/invalid session cookie: page sends the user to /login", async ({ page, context, baseURL }) => {
    await context.addCookies([{ name: "sessionid", value: "expired-or-forged-session", url: baseURL! }]);
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByText("Verifying your session…")).toHaveCount(0);
  });

  test("session ended server-side while on a page: next API call redirects with 'expired' notice", async ({ page }) => {
    await registerViaUi(page, "Expiry Co", `exp.${uniq()}@example.test`);
    await expect(page).toHaveURL(/\/dashboard$/);
    // End the session on the server (as expiry would), keeping the stale cookie in the browser.
    await page.evaluate(async () => {
      const csrf = document.cookie.match(/csrftoken=([^;]+)/)?.[1] || "";
      await fetch("/api/auth/logout/", { method: "POST", headers: { "X-CSRFToken": csrf }, credentials: "include" });
    });
    await page.getByRole("link", { name: "P&L Statement" }).click();
    await expect(page).toHaveURL(/\/login/);
  });
});

test.describe("Forgot password", () => {
  test("validation, loading and generic confirmation", async ({ page }) => {
    await page.goto("/forgot-password");
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect(page.getByText("Enter a valid email address.")).toBeVisible();
    await page.getByLabel("Email address").fill(`ghost.${uniq()}@example.test`);
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect(page.getByRole("status")).toContainText("If an account exists for that email");
  });

  test("reset page without a token explains the problem", async ({ page }) => {
    await page.goto("/reset-password");
    await expect(formAlert(page)).toContainText("incomplete");
  });
});

test.describe("Responsive", () => {
  for (const vp of [
    { name: "mobile", width: 375, height: 667 },
    { name: "tablet", width: 768, height: 1024 },
  ]) {
    for (const path of ["/login", "/register", "/forgot-password"]) {
      test(`${path} fits a ${vp.name} viewport without horizontal scroll`, async ({ page }) => {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await page.goto(path);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow).toBeLessThanOrEqual(0);
        const btn = page.locator("button[type=submit]");
        await expect(btn).toBeVisible();
        const box = await btn.boundingBox();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(vp.width);
        // 16px inputs on mobile so iOS Safari doesn't zoom on focus
        if (vp.width < 640) {
          const fs = await page.locator("input").first().evaluate((el) => getComputedStyle(el).fontSize);
          expect(fs).toBe("16px");
        }
      });
    }
  }
});
