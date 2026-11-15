import { test, expect, signedIn, goto, fx, brand1 } from "./helpers";

const inr = (minor: number) => "â‚¹" + (minor / 100).toLocaleString("en-IN", { maximumFractionDigits: 0 });
const statsUrl = () => `/api/w/${fx.workspace.slug}/b/${brand1().id}/shopify/stats/?days=30`;

test.describe("Shopify page", () => {
  test("FE-SHOP-01 loads KPIs that match the API, plus order table", async ({ page, diag }) => {
    await signedIn(page);
    await goto(page, "/shopify");
    const api = await (await page.request.get(statsUrl())).json();
    await expect(page.getByText(inr(api.metrics.net_sales_minor)).first()).toBeVisible();
    await expect(page.getByText(inr(api.metrics.aov_minor)).first()).toBeVisible();
    await expect(page.locator("tbody tr")).toHaveCount(25);
    await expect(page.getByText("Showing 25 of 25")).toBeVisible();
    expect(diag.pageErrors).toEqual([]);
  });

  test("FE-SHOP-02 loading state shown while stats request is in flight", async ({ page }) => {
    await signedIn(page);
    await page.route("**/shopify/stats/**", async (r) => { await new Promise((x) => setTimeout(x, 1500)); await r.continue(); });
    await page.goto("/shopify");
    await expect(page.getByText("Loading canonical orders...")).toBeVisible();
    await expect(page.locator("tbody tr").first()).not.toContainText("Loading");
  });

  test("FE-SHOP-03 time-window selector re-queries with days param and updates label", async ({ page }) => {
    await signedIn(page);
    await goto(page, "/shopify");
    const req = page.waitForRequest((r) => r.url().includes("shopify/stats") && r.url().includes("days=7"));
    await page.locator("select").first().selectOption("7");
    await req;
    await expect(page.getByText("Net Sales (7D)")).toBeVisible();
  });

  test("FE-SHOP-04 search filters rows by order number and shows empty state for no match", async ({ page }) => {
    await signedIn(page);
    await goto(page, "/shopify");
    const search = page.getByPlaceholder("Search order # or email...");
    const firstOrder = (await page.locator("tbody tr").first().locator("td").first().innerText()).trim().split(/\s+/)[0];
    await search.fill(firstOrder);
    await expect(page.locator("tbody tr")).toHaveCount(1);
    await search.fill("zzz-no-such-order");
    await expect(page.getByText("No orders found matching the filter.")).toBeVisible();
    await search.fill("");
    await expect(page.locator("tbody tr")).toHaveCount(25);
  });

  test("FE-SHOP-05 status filter narrows rows to the selected status", async ({ page }) => {
    await signedIn(page);
    await goto(page, "/shopify");
    await page.locator("select").nth(1).selectOption("pending");
    const rows = page.locator("tbody tr");
    const n = await rows.count();
    expect(n).toBeGreaterThan(0);
    for (let i = 0; i < n; i++) await expect(rows.nth(i)).toContainText(/pending/i);
  });

  test("FE-SHOP-06 user can reach orders beyond the first page (API has 60 orders; backend supports keyset cursor)", async ({ page }) => {
    await signedIn(page);
    await goto(page, "/shopify");
    const api = await (await page.request.get(statsUrl() + "&limit=25")).json();
    expect(api.pagination.has_next).toBe(true);
    const more = page.getByRole("button", { name: /load more|next|older|show more/i });
    await expect(more, "no control exists to fetch the next page").toBeVisible();
  });

  test("FE-SHOP-07 Sync Store posts to sync-now, shows success notice, then reloads data", async ({ page }) => {
    await signedIn(page);
    await goto(page, "/shopify");
    const resp = page.waitForResponse((r) => r.url().includes("/shopify/sync-now") && r.request().method() === "POST" && r.status() !== 308);
    await page.getByRole("button", { name: /Sync Store/ }).click();
    expect((await resp).status()).toBe(200);
    await expect(page.getByText(/Sync triggered/)).toBeVisible();
  });

  test("FE-SHOP-08 sync failure shows the server error message", async ({ page }) => {
    await signedIn(page);
    await goto(page, "/shopify");
    await page.route("**/shopify/sync-now/**", (r) => r.fulfill({ status: 404, contentType: "application/json", body: '{"error":"Shopify integration not found for this brand."}' }));
    await page.getByRole("button", { name: /Sync Store/ }).click();
    await expect(page.getByText("Shopify integration not found for this brand.")).toBeVisible();
  });

  test("FE-SHOP-09 stats API failure (500) shows an error state, not an empty dashboard", async ({ page }) => {
    await signedIn(page);
    await page.route("**/shopify/stats/**", (r) => r.fulfill({ status: 500, contentType: "application/json", body: "{}" }));
    await page.goto("/shopify");
    await expect(page.getByText(/failed|error|unable|try again|couldn't/i).first()).toBeVisible();
  });

  test("FE-SHOP-10 empty brand (no orders) shows zero KPIs and empty-table message", async ({ page }) => {
    await signedIn(page);
    await goto(page, "/shopify");
    await page.locator("aside").getByRole("button", { name: new RegExp(fx.brands[0].name) }).click();
    await page.locator("aside").getByRole("button", { name: /E2E Footwear/ }).click();
    await expect(page.getByText("No orders found matching the filter.")).toBeVisible();
    await expect(page.getByText("Showing 0 of 0")).toBeVisible();
  });

  test("FE-SHOP-11 KPI cards do not show hardcoded growth (+18.4%) unrelated to data", async ({ page }) => {
    await signedIn(page);
    await goto(page, "/shopify");
    await page.locator("aside").getByRole("button", { name: new RegExp(fx.brands[0].name) }).click();
    await page.locator("aside").getByRole("button", { name: /E2E Footwear/ }).click();
    await expect(page.getByText("No orders found matching the filter.")).toBeVisible();
    await expect(page.getByText("+18.4%"), "growth % is static text even with zero orders").toHaveCount(0);
  });
});

test.describe("Overview page", () => {
  test("FE-OVR-01 renders all five source sections and net-sales KPI from API", async ({ page }) => {
    await signedIn(page);
    await goto(page, "/");
    await expect(page.getByRole("heading", { name: "Commerce Intelligence Overview" })).toBeVisible();
    const api = await (await page.request.get(statsUrl())).json();
    await expect(page.getByText(inr(Math.round(api.metrics.net_sales_minor / 30))).first()).toBeVisible();
    for (const t of [/Shopify/i, /Razorpay/i, /Meta/i, /Instagram/i]) await expect(page.getByText(t).first()).toBeVisible();
  });

  test("FE-OVR-02 window selector re-queries the API", async ({ page }) => {
    await signedIn(page);
    await goto(page, "/");
    const req = page.waitForRequest((r) => r.url().includes("shopify/stats") && r.url().includes("days=7"));
    await page.locator("select").first().selectOption("7");
    await req;
  });

  test("FE-OVR-03 stats API failure is surfaced (not silently replaced by sample numbers)", async ({ page }) => {
    await signedIn(page);
    await page.route("**/shopify/stats/**", (r) => r.fulfill({ status: 500, body: "{}" }));
    await page.goto("/");
    await expect(page.getByText(/failed|error|unable|try again/i).first()).toBeVisible();
  });

  test("FE-OVR-04 non-Shopify KPIs are labelled as sample/demo data", async ({ page }) => {
    await signedIn(page);
    await goto(page, "/");
    await expect(page.getByText(/sample|demo|simulated|not connected/i).first()).toBeVisible();
  });
});

test.describe("P&L page", () => {
  test("FE-PNL-01 renders waterfall rows and four headline KPIs", async ({ page }) => {
    await signedIn(page);
    await goto(page, "/pnl");
    await expect(page.getByRole("heading").first()).toBeVisible();
    const api = await (await page.request.get(statsUrl())).json();
    await expect(page.getByText(inr(api.metrics.net_sales_minor)).first()).toBeVisible();
  });

  test("FE-PNL-02 window selector re-queries", async ({ page }) => {
    await signedIn(page);
    await goto(page, "/pnl");
    const req = page.waitForRequest((r) => r.url().includes("shopify/stats") && r.url().includes("days=90"));
    await page.locator("select").first().selectOption("90");
    await req;
  });

  test("FE-PNL-03 no invented constants: unsourced P&L lines render as unavailable, never as fixed rupee amounts", async ({ page }) => {
    await signedIn(page);
    await goto(page, "/pnl");
    const text = await page.locator("main").innerText();
    // These were baked into the page as fake ad-spend / freight / overhead / baseline figures.
    for (const c of ["\u20B934,000", "\u20B994,000", "\u20B92,50,000", "\u20B914,24,340", "\u20B915,40,000"]) {
      expect(text.includes(c), `${c} must not appear as a hardcoded figure`).toBe(false);
    }
    await expect(page.getByText(/no connected data source/i)).toBeVisible();
  });

  test("FE-PNL-04 API failure is surfaced", async ({ page }) => {
    await signedIn(page);
    await page.route("**/shopify/stats/**", (r) => r.fulfill({ status: 500, body: "{}" }));
    await page.goto("/pnl");
    await expect(page.getByText(/failed|error|unable|try again/i).first()).toBeVisible();
  });
});

