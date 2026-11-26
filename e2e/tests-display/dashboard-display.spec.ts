// Display check: every number on the dashboard pages is formatted from the API values.
// The API is mocked with the values verified by the serverless metrics audit (73 checks), so this test
// proves the SCREEN shows those values correctly. It does not contact any backend.
import { expect, test, type Page, type Route } from "@playwright/test";

const WS = "fixture-store";
const BRAND = "11111111-2222-4333-8444-555555555555";
const ORIGIN = process.env.E2E_BASE_URL || "http://localhost:3100";

const brand = { id: BRAND, name: "Fixture Brand", currency: "INR", timezone: "Asia/Kolkata" };
const session = {
  user: { id: "u-1", email: "owner@fixture.test", first_name: "Olive", last_name: "Owner", is_superuser: false, mfa_enabled: false },
  workspaces: [{ id: "w-1", name: "Fixture Store", slug: WS, role: "owner", brands: [brand] }],
  redirect: "/dashboard",
};

const shopify = {
  brand, days: 30,
  metrics: {
    net_sales_minor: 47000, gross_sales_minor: 56700, discount_total_minor: 1700, refunds_minor: 8000,
    order_count: 4, aov_minor: 11750, tax_total_minor: 8460, shipping_total_minor: 1300, order_total_minor: 56760,
    refunded_order_count: 1, partially_refunded_order_count: 1,
  },
  previous: { net_sales_minor: 39000, aov_minor: 19500, order_count: 2 },
  change_pct: { net_sales: 20.5, aov: -39.7, orders: 100 },
  funnel: { placed: 4, paid: 2, fulfilled: 2, partial: 1, unfulfilled: 1 },
  orders: [],
};

const payments = {
  connected: true, provider: "razorpay", payment_count: 4, attempt_count: 6, authorized_rate: 66.7,
  total_captured_minor: 110000, total_fees_minor: null, method_splits: { upi: 50, card: 25, netbanking: 25 },
};

const overview = {
  metrics: {
    blended_roas: { value: 2.94, available: true }, blended_cac: { value: null, available: false },
    delivery_success_pct: { value: null, available: false }, orders_to_be_shipped: { value: 1, available: true },
    number_of_disputes: { value: null, available: false }, organic_engagement: { value: null, available: false },
  },
};

const pnl = {
  brand, days: 30, revenue: shopify.metrics,
  lines: {
    gross_sales_minor: 56700, discounts_minor: 1700, refunds_minor: 8000, net_revenue_minor: 47000,
    cogs_minor: 16450, gross_margin_minor: 30550, ad_spend_minor: 16000, gateway_charges_minor: 940,
    shipping_costs_minor: 30000, cm1_minor: -16390, fixed_overhead_minor: null, ebitda_minor: null,
  },
  pct_of_net: { gross_sales: 120.6, discounts: 3.6, refunds: 17, cogs: 35, gross_margin: 65, ad_spend: 34, gateway_charges: 2, shipping_costs: 63.8, cm1: -34.9, ebitda: null },
  memo: { tax_collected_minor: 8460, shipping_charged_minor: 1300, partially_refunded_order_count: 1 },
  estimated: ["cogs_minor", "gateway_charges_minor", "shipping_costs_minor"], assumptions: {}, sources: { ad_spend: "meta_ads" },
};

const marketing = {
  connected: true, token_expired: false,
  summary_30d: { spend_minor: 16000, impressions: 30000, clicks: 550, ctr: 1.83, cpc_minor: 29, cpm_minor: 533, orders: 4, attributed_revenue_minor: 54000, roas: 3.38 },
  summary_lifetime: { spend_minor: 20000, impressions: 35000, clicks: 600, ctr: 1.71, cpc_minor: 33, cpm_minor: 571, orders: 5, attributed_revenue_minor: 54000, roas: 2.7 },
  campaigns: [], daily_trends: [],
};

const logistics = {
  total_shipments: 6, in_transit_count: 2, delivered_count: 2, ndr_count: 2,
  ndr_rate_percentage: 33.3, rto_rate_percentage: 33.3, avg_delivery_days: 3.5,
};

async function mockApi(page: Page) {
  await page.route("**/api/**", async (route: Route) => {
    const p = new URL(route.request().url()).pathname;
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (p === "/api/auth/me") return json(session);
    if (p === "/api/modules/effective") {
      return json({ shopify: true, razorpay: true, meta_ads: true, delivery: true, instagram: true, attribution: true });
    }
    if (p.includes("/shopify/stats")) return json(shopify);
    if (p.includes("/payments/transactions")) return json([]);
    if (p.includes("/payments/stats")) return json(payments);
    if (/\/metrics\/?$/.test(p)) return json(overview);
    if (/\/pnl\/?$/.test(p)) return json(pnl);
    if (p.includes("/marketing/stats")) return json(marketing);
    if (p.includes("/logistics/summary")) return json(logistics);
    if (p.includes("/logistics/shipments")) return json([]);
    if (p.includes("/integrations")) return json([]);
    if (p.includes("/members")) return json([]);
    if (p.includes("/mfa/status")) return json({ is_enabled: false, is_pending: false, recovery_codes_left: 0 });
    return json({ error: "not mocked in this test" }, 404);
  });
}

async function signIn(page: Page) {
  await page.context().addCookies([{ name: "sessionid", value: "display-test", url: ORIGIN }]);
  await mockApi(page);
}

test("Shopify page shows net sales, gross, AOV and the change vs previous period", async ({ page }) => {
  await signIn(page);
  await page.goto("/shopify", { waitUntil: "networkidle" });
  await expect(page.getByText("₹470").first()).toBeVisible({ timeout: 20_000 }); // net sales 47000 paise
  await expect(page.getByText(/Gross:\s*₹567/)).toBeVisible();                  // gross 56700 paise
  await expect(page.getByText("₹118").first()).toBeVisible();                   // AOV 11750 -> ₹117.50 -> ₹118
  await expect(page.getByText(/20\.5/).first()).toBeVisible();                  // change vs previous period
});

test("Payments page shows success rate and captured total", async ({ page }) => {
  await signIn(page);
  await page.goto("/payments", { waitUntil: "networkidle" });
  await expect(page.getByText(/66\.7/).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/1,100/).first()).toBeVisible();                  // captured 110000 paise
});

test("Overview page shows blended ROAS", async ({ page }) => {
  await signIn(page);
  await page.goto("/dashboard", { waitUntil: "networkidle" });
  await expect(page.getByText(/2\.94/).first()).toBeVisible({ timeout: 20_000 });
});

test("P&L page shows net revenue", async ({ page }) => {
  await signIn(page);
  await page.goto("/pnl", { waitUntil: "networkidle" });
  await expect(page.getByText("₹470").first()).toBeVisible({ timeout: 20_000 }); // net revenue 47000 paise
});

test("Marketing page shows Meta ROAS and spend (30 days)", async ({ page }) => {
  await signIn(page);
  await page.goto("/marketing", { waitUntil: "networkidle" });
  await expect(page.getByText(/3\.38/).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("₹160").first()).toBeVisible();                   // spend 16000 paise
});

test("Logistics page shows shipment rates and the waybill sync panel", async ({ page }) => {
  await signIn(page);
  await page.goto("/logistics", { waitUntil: "networkidle" });
  await expect(page.getByText(/33\.3/).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Sync shipments")).toBeVisible();
});

test("Settings shows working webhook URLs and no /api/webhooks path", async ({ page }) => {
  await signIn(page);
  await page.goto("/settings", { waitUntil: "networkidle" });
  await expect(page.locator(`input[readonly][value$="/webhook-shopify?brand_id=${BRAND}"]`)).toHaveCount(1, { timeout: 20_000 });
  await expect(page.locator(`input[readonly][value$="/webhook-razorpay?brand_id=${BRAND}"]`)).toHaveCount(1);
  await expect(page.locator('input[readonly][value*="/api/webhooks/"]')).toHaveCount(0);
});
