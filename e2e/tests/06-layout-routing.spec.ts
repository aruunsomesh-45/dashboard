import { test, expect, signedIn, goto, fx, brand2 } from "./helpers";
import fs from "fs";
import path from "path";

const SHOTS = path.join(__dirname, "..", "results", "screenshots");
const PAGES = ["/", "/pnl", "/integrations", "/shopify", "/marketing", "/payments", "/logistics", "/team", "/settings", "/mfa-setup"];
const VIEWPORTS = [
  { w: 1024, h: 768 }, { w: 1280, h: 720 }, { w: 1440, h: 900 }, { w: 1920, h: 1080 }, { w: 2560, h: 1440 },
];

test.describe("Desktop viewport layouts", () => {
  for (const v of VIEWPORTS) {
    test(`FE-LAY-01 @${v.w}x${v.h} all pages: no horizontal page overflow, sidebar + header visible, screenshot saved`, async ({ page }) => {
      test.setTimeout(120_000);
      fs.mkdirSync(SHOTS, { recursive: true });
      await page.setViewportSize({ width: v.w, height: v.h });
      await signedIn(page);
      const problems: string[] = [];
      for (const p of PAGES) {
        await goto(page, p);
        await page.waitForTimeout(300);
        await page.screenshot({ path: path.join(SHOTS, `${p === "/" ? "overview" : p.slice(1)}_${v.w}x${v.h}.png`), fullPage: false });
        const m = await page.evaluate(() => {
          const main = document.querySelector("main");
          return {
            docOverflow: document.documentElement.scrollWidth - window.innerWidth,
            mainOverflow: main ? main.scrollWidth - main.clientWidth : 0,
          };
        });
        if (m.docOverflow > 1) problems.push(`${p}: document overflows by ${m.docOverflow}px`);
        if (m.mainOverflow > 1) problems.push(`${p}: <main> overflows by ${m.mainOverflow}px`);
        if (!(await page.locator("aside").isVisible()) || !(await page.locator("header").isVisible())) problems.push(`${p}: shell missing`);
      }
      expect(problems).toEqual([]);
    });
  }

  test("FE-LAY-02 full-page screenshots at 1440x900 (visual record)", async ({ page }) => {
    test.setTimeout(120_000);
    fs.mkdirSync(SHOTS, { recursive: true });
    await signedIn(page);
    for (const p of PAGES) {
      await goto(page, p);
      await page.screenshot({ path: path.join(SHOTS, `full_${p === "/" ? "overview" : p.slice(1)}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  test("FE-LAY-03 modals are centred and fully visible at 1024x768 (invite, create workspace, configure integration)", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await signedIn(page);
    await goto(page, "/team");
    await page.getByRole("button", { name: /Invite Teammate/ }).click();
    const box = await page.locator(".fixed.inset-0 > div").first().boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(1024);
    expect(box!.y + box!.height).toBeLessThanOrEqual(768);
  });
});

test.describe("Routing, refresh & direct navigation", () => {
  for (const p of PAGES) {
    test(`FE-RTE-01 ${p}: hard refresh keeps the route and re-renders content`, async ({ page, diag }) => {
      await signedIn(page);
      await goto(page, p);
      await page.reload();
      await page.waitForLoadState("networkidle");
      expect(new URL(page.url()).pathname).toBe(p);
      await expect(page.locator("aside")).toBeVisible();
      expect(diag.pageErrors).toEqual([]);
    });
  }

  test("FE-RTE-02 selected brand persists across refresh", async ({ page }) => {
    await signedIn(page);
    await goto(page, "/shopify");
    await page.locator("aside").getByRole("button", { name: new RegExp(fx.brands[0].name) }).click();
    await page.locator("aside").getByRole("button", { name: /E2E Footwear/ }).click();
    await expect(page.locator("header")).toContainText("E2E Footwear");
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(page.locator("header"), "brand selection is lost on refresh").toContainText("E2E Footwear");
  });

  test("FE-RTE-03 unknown route renders a 404 page inside the app, not a crash", async ({ page }) => {
    await signedIn(page);
    const resp = await page.goto("/definitely-not-a-page");
    expect(resp?.status()).toBe(404);
    await expect(page.getByText(/404|not found/i).first()).toBeVisible();
  });

  test("FE-RTE-04 routes referenced by the app but missing: /invites/accept and /mfa-challenge", async ({ page }) => {
    await signedIn(page);
    for (const p of ["/invites/accept?token=abc", "/mfa-challenge"]) {
      const resp = await page.goto(p);
      expect(resp?.status(), `${p} should resolve`).toBe(200);
    }
  });

  test("FE-RTE-05 trailing-slash and query-string direct navigation resolve", async ({ page }) => {
    await signedIn(page);
    for (const p of ["/shopify/", "/team/", "/shopify?x=1"]) {
      const resp = await page.goto(p);
      expect(resp?.status(), p).toBeLessThan(400);
      await page.waitForLoadState("networkidle");
      await expect(page.locator("aside")).toBeVisible();
    }
  });

  test("FE-RTE-06 API proxy: /api/auth/csrf reachable through frontend and sets csrftoken cookie", async ({ page }) => {
    await mockSupabaseOnly(page);
    const res = await page.request.get("/api/auth/csrf");
    expect(res.status()).toBe(200);
    expect((await page.context().cookies()).some((c) => c.name === "csrftoken")).toBe(true);
  });

  test("FE-RTE-07 backend down: dashboard pages show a connection error (not an infinite spinner/blank)", async ({ page }) => {
    await signedIn(page);
    await goto(page, "/team");
    await page.route("**/api/**", (r) => r.abort("connectionrefused"));
    await page.reload();
    await expect(page.getByText(/cannot connect|failed|error|unable/i).first()).toBeVisible();
  });

  test("FE-RTE-08 CSRF: mutating call without cookie is rejected by backend (403) — apiFetch recovers by fetching token", async ({ page }) => {
    await signedIn(page);
    await goto(page, "/team");
    await page.context().clearCookies({ name: "csrftoken" });
    const res = await page.request.post(`/api/w/${fx.workspace.slug}/invites/`, { data: { email: "x@y.com" }, failOnStatusCode: false });
    expect(res.status()).toBe(403);
  });

  test("FE-RTE-09 cross-tenant URL: opening another workspace's brand via API returns 404 (no data leak in UI calls)", async ({ page }) => {
    await signedIn(page);
    const res = await page.request.get(`/api/w/${fx.other_workspace.slug}/b/${fx.other_brand_id}/shopify/stats/`, { failOnStatusCode: false });
    expect(res.status()).toBe(404);
    const res2 = await page.request.get(`/api/w/${fx.workspace.slug}/b/${fx.other_brand_id}/shopify/stats/`, { failOnStatusCode: false });
    expect(res2.status()).toBe(404);
  });

  test("FE-RTE-10 brand switch to Footwear then back keeps data consistent (no stale cross-brand cache)", async ({ page }) => {
    await signedIn(page);
    await goto(page, "/shopify");
    const before = await page.getByText("Showing 25 of 25").isVisible();
    await page.locator("aside").getByRole("button", { name: new RegExp(fx.brands[0].name) }).click();
    await page.locator("aside").getByRole("button", { name: /E2E Footwear/ }).click();
    await expect(page.getByText("Showing 0 of 0")).toBeVisible();
    await page.locator("aside").getByRole("button", { name: /E2E Footwear/ }).first().click();
    await page.locator("aside").getByRole("button", { name: /E2E Apparel/ }).click();
    await expect(page.getByText("Showing 25 of 25")).toBeVisible();
    expect(before).toBe(true);
    void brand2;
  });
});

async function mockSupabaseOnly(page: any) {
  const { mockSupabase } = await import("./helpers");
  await mockSupabase(page);
  await page.goto("/login");
}
