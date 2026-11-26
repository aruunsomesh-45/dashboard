import { test, expect, signedIn, goto, fx, brand2 } from "./helpers";

const NAV: [string, string][] = [
  ["Overview", "/"], ["P&L Statement", "/pnl"], ["Connect Apps", "/integrations"], ["Shopify Store", "/shopify"],
  ["Marketing & Ads", "/marketing"], ["Payments", "/payments"], ["Logistics", "/logistics"],
  ["Team & Access", "/team"], ["Settings", "/settings"],
];

test.describe("Dashboard shell & navigation", () => {
  test("FE-NAV-01 shell shows workspace, brand, user email, role badge and currency/timezone chip", async ({ page }) => {
    await signedIn(page);
    await goto(page, "/");
    await expect(page.getByText(fx.workspace.name).first()).toBeVisible();
    await expect(page.getByText(fx.brands[0].name).first()).toBeVisible();
    await expect(page.getByText(fx.users.owner.email)).toBeVisible();
    await expect(page.getByText("INR (Asia/Kolkata)")).toBeVisible();
  });

  test("FE-NAV-02 every sidebar link navigates client-side to its route and highlights as active", async ({ page }) => {
    await signedIn(page);
    await goto(page, "/");
    for (const [label, href] of NAV) {
      const link = page.locator("aside nav").getByRole("link", { name: label, exact: true });
      await link.click();
      await page.waitForURL((u) => u.pathname === href);
      await expect(link).toHaveClass(/bg-terracotta-500/);
    }
  });

  test("FE-NAV-03 browser back/forward between pages works", async ({ page }) => {
    await signedIn(page);
    await goto(page, "/");
    await page.locator("aside nav").getByRole("link", { name: "Shopify Store" }).click();
    await page.waitForURL(/\/shopify/);
    await page.locator("aside nav").getByRole("link", { name: "Team & Access" }).click();
    await page.waitForURL(/\/team/);
    await page.goBack();
    await expect(page).toHaveURL(/\/shopify/);
    await page.goBack();
    await expect(page).toHaveURL(/\/$/);
    await page.goForward();
    await expect(page).toHaveURL(/\/shopify/);
  });

  test("FE-NAV-04 workspace dropdown opens, lists workspace + role, closes on selection", async ({ page }) => {
    await signedIn(page);
    await goto(page, "/");
    await page.getByRole("button", { name: new RegExp(fx.workspace.name) }).first().click();
    const item = page.locator("aside").getByRole("button", { name: new RegExp(`${fx.workspace.name}\\s*owner`, "i") });
    await expect(item).toBeVisible();
    await expect(page.getByRole("button", { name: /Create Workspace/ })).toBeVisible();
    await item.click();
    await expect(page.getByRole("button", { name: /Create Workspace/ })).toHaveCount(0);
  });

  test("FE-NAV-05 brand dropdown lists both brands and switching updates header + data requests", async ({ page }) => {
    await signedIn(page);
    await goto(page, "/shopify");
    await page.locator("aside").getByRole("button", { name: new RegExp(fx.brands[0].name) }).click();
    await expect(page.locator("aside").getByRole("button", { name: /E2E Footwear/ })).toBeVisible();
    const req = page.waitForRequest((r) => r.url().includes(`/b/${brand2().id}/shopify/stats`));
    await page.locator("aside").getByRole("button", { name: /E2E Footwear/ }).click();
    await req;
    await expect(page.locator("header")).toContainText("E2E Footwear");
  });

  test("FE-NAV-06 create-workspace modal: empty name blocked, cancel closes, submit posts to API", async ({ page }) => {
    await signedIn(page);
    await goto(page, "/");
    await page.getByRole("button", { name: new RegExp(fx.workspace.name) }).first().click();
    await page.getByRole("button", { name: /Create Workspace/ }).click();
    const modal = page.getByRole("heading", { name: "Create New Workspace" });
    await expect(modal).toBeVisible();
    await page.getByRole("button", { name: "Create Workspace", exact: true }).click(); // empty -> native required
    await expect(modal).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(modal).toHaveCount(0);
    await page.getByRole("button", { name: new RegExp(fx.workspace.name) }).first().click();
    await page.getByRole("button", { name: /Create Workspace/ }).click();
    await page.getByPlaceholder("e.g. 125 East Retail Ltd").fill("E2E Created WS");
    const resp = page.waitForResponse((r) => r.url().includes("/api/w") && r.request().method() === "POST" && r.status() !== 308);
    await page.getByRole("button", { name: "Create Workspace", exact: true }).click();
    expect((await resp).status()).toBe(201);
    await expect(modal).toHaveCount(0);
  });

  test("FE-NAV-07 create-workspace API failure is surfaced to the user", async ({ page, diag }) => {
    await signedIn(page);
    await goto(page, "/");
    await page.route("**/api/w/", (r) => (r.request().method() === "POST" ? r.fulfill({ status: 400, contentType: "application/json", body: '{"error":"Workspace name is required."}' }) : r.continue()));
    await page.getByRole("button", { name: new RegExp(fx.workspace.name) }).first().click();
    await page.getByRole("button", { name: /Create Workspace/ }).click();
    await page.getByPlaceholder("e.g. 125 East Retail Ltd").fill("X");
    await page.getByRole("button", { name: "Create Workspace", exact: true }).click();
    await expect.poll(() => diag.dialogs.length).toBeGreaterThan(0);
    expect(diag.dialogs[0]).toContain("Workspace name is required.");
  });

  test("FE-NAV-08 sign out ends the session: Supabase signOut + redirect to /login + Django session invalidated", async ({ page }) => {
    const sb = await signedIn(page);
    await goto(page, "/");
    await page.getByRole("button", { name: /Sign Out/ }).click();
    await page.waitForURL(/\/login/);
    expect(sb.log.some((l) => l.includes("/auth/v1/logout"))).toBe(true);
    const me = await page.request.get("/api/auth/me");
    expect(me.status(), "Django session should be invalid after sign out").toBeGreaterThanOrEqual(401);
  });

  test("FE-NAV-09 MFA link in footer goes to /mfa-setup", async ({ page }) => {
    await signedIn(page);
    await goto(page, "/");
    await page.getByRole("link", { name: /Enable MFA/ }).click();
    await expect(page).toHaveURL(/\/mfa-setup/);
  });

  test("FE-NAV-10 header 'Date: Last 30 Days' control is interactive", async ({ page }) => {
    await signedIn(page);
    await goto(page, "/");
    const chip = page.getByText("Date: Last 30 Days");
    await expect(chip).toBeVisible();
    // A date-range control should be a button/select; it is plain text today.
    expect(await chip.evaluate((el) => el.tagName === "BUTTON" || !!el.closest("button,select,[role=button]"))).toBe(true);
  });

  test("FE-NAV-11 user with no workspaces gets a usable empty state", async ({ page }) => {
    await signedIn(page, "owner", { noWorkspaces: true });
    await goto(page, "/");
    await expect(page.getByText(/create (a )?workspace|no workspace|get started/i).first()).toBeVisible();
  });

  test("FE-NAV-12 Supabase table read failure does not leave a blank cockpit", async ({ page }) => {
    await signedIn(page, "owner", { tablesFail: true });
    await goto(page, "/");
    await expect(page.getByText(/error|failed|try again|unable/i).first()).toBeVisible();
  });
});

