// UI audit: screenshots and layout checks for every main page, at desktop and phone widths.
// API responses are mocked, so this checks layout only. Output: e2e/ui-audit/ (screenshots + report.json).
import { test, type Page, type Route } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";

const ORIGIN = process.env.E2E_BASE_URL || "http://localhost:3100";
const OUT = path.join(__dirname, "..", "ui-audit");
const BRAND = "11111111-2222-4333-8444-555555555555";
const brand = { id: BRAND, name: "Fixture Brand", currency: "INR", timezone: "Asia/Kolkata" };
const session = {
  user: { id: "u-1", email: "owner@fixture.test", first_name: "Olive", last_name: "Owner", is_superuser: false, mfa_enabled: false },
  workspaces: [{ id: "w-1", name: "Fixture Store", slug: "fixture-store", role: "owner", brands: [brand] }],
  redirect: "/dashboard",
};
const shopify = {
  brand, days: 30,
  metrics: { net_sales_minor: 47000, gross_sales_minor: 56700, discount_total_minor: 1700, refunds_minor: 8000, order_count: 4, aov_minor: 11750, tax_total_minor: 8460, shipping_total_minor: 1300, order_total_minor: 56760, refunded_order_count: 1, partially_refunded_order_count: 1 },
  previous: { net_sales_minor: 39000, aov_minor: 19500, order_count: 2 }, change_pct: { net_sales: 20.5, aov: -39.7, orders: 100 },
  funnel: { placed: 4, paid: 2, fulfilled: 2, partial: 1, unfulfilled: 1 },
  orders: [{ id: "o1", order_number: "#1001", customer_name: "Asha K", customer_email: "asha@example.test", currency: "INR", gross_amount: 118000, discount_amount: 1000, tax_amount: 500, shipping_amount: 200, net_sales: 100000, financial_status: "paid", fulfillment_status: "unfulfilled", source_created_at: new Date().toISOString(), lines_count: 2 }],
};
const payments = { connected: true, provider: "razorpay", payment_count: 4, attempt_count: 6, authorized_rate: 66.7, total_captured_minor: 110000, total_fees_minor: null, method_splits: { upi: 50, card: 25, netbanking: 25 } };
const campaign = { id: "111", name: "Summer Sale 2026 Long Campaign Name For Testing", status: "active", effective_status: "active", spend_minor: 2000000, impressions: 400000, clicks: 9000, ctr: 2.25, cpc_minor: 22, roas: 3.4, orders: 300, attributed_revenue_minor: 6800000 };
const marketing = {
  connected: true, token_expired: false,
  summary_30d: { spend_minor: 16000, impressions: 30000, clicks: 550, ctr: 1.83, cpc_minor: 29, cpm_minor: 533, orders: 4, attributed_revenue_minor: 54000, roas: 3.38 },
  summary_lifetime: { spend_minor: 20000, impressions: 35000, clicks: 600, ctr: 1.71, cpc_minor: 33, cpm_minor: 571, orders: 5, attributed_revenue_minor: 54000, roas: 2.7 },
  campaigns: [campaign], campaigns_lifetime: [campaign], daily_trends: [],
};
const pnl = { brand, days: 30, revenue: shopify.metrics,
  lines: { gross_sales_minor: 56700, discounts_minor: 1700, refunds_minor: 8000, net_revenue_minor: 47000, cogs_minor: 16450, gross_margin_minor: 30550, ad_spend_minor: 16000, gateway_charges_minor: 940, shipping_costs_minor: 30000, cm1_minor: -16390, fixed_overhead_minor: null, ebitda_minor: null },
  pct_of_net: { gross_sales: 120.6, discounts: 3.6, refunds: 17, cogs: 35, gross_margin: 65, ad_spend: 34, gateway_charges: 2, shipping_costs: 63.8, cm1: -34.9, ebitda: null },
  memo: { tax_collected_minor: 8460, shipping_charged_minor: 1300, partially_refunded_order_count: 1 }, estimated: [], assumptions: {}, sources: { ad_spend: "meta_ads" } };
const logistics = { total_shipments: 6, in_transit_count: 2, delivered_count: 2, ndr_count: 2, ndr_rate_percentage: 33.3, rto_rate_percentage: 33.3, avg_delivery_days: 3.5 };

async function mock(page: Page) {
  await page.context().addCookies([{ name: "sessionid", value: "ui-audit", url: ORIGIN }]);
  await page.route("**/api/**", async (route: Route) => {
    const p = new URL(route.request().url()).pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (p === "/api/auth/me") return json(session);
    if (p === "/api/modules/effective") return json({ shopify: true, razorpay: true, meta_ads: true, delivery: true, instagram: true, attribution: true });
    if (p.includes("/shopify/stats")) return json(shopify);
    if (p.includes("/payments/transactions")) return json([]);
    if (p.includes("/payments/stats")) return json(payments);
    if (/\/metrics\/?$/.test(p)) return json({ metrics: { blended_roas: { value: 2.94, available: true }, blended_cac: { value: null, available: false }, delivery_success_pct: { value: null, available: false }, orders_to_be_shipped: { value: 1, available: true }, number_of_disputes: { value: null, available: false }, organic_engagement: { value: null, available: false } } });
    if (/\/pnl\/?$/.test(p)) return json(pnl);
    if (p.includes("/marketing/stats")) return json(marketing);
    if (p.includes("/logistics/summary")) return json(logistics);
    if (p.includes("/logistics/shipments")) return json([]);
    if (p.includes("/integrations")) return json([]);
    if (p.includes("/members")) return json([]);
    if (p.includes("/mfa/status")) return json({ is_enabled: false, is_pending: false, recovery_codes_left: 0 });
    return json({ error: "not mocked" }, 404);
  });
}

const PAGES = ["/dashboard", "/shopify", "/payments", "/pnl", "/logistics", "/marketing", "/marketing/links", "/integrations", "/team", "/workspace", "/settings", "/guide", "/login", "/register", "/forgot-password"];
const VIEWPORTS = [
  { name: "desktop", width: 1366, height: 800 },
  { name: "phone", width: 390, height: 844 },
];

const findings: Record<string, unknown>[] = [];

test.beforeAll(() => fs.mkdirSync(OUT, { recursive: true }));

for (const vp of VIEWPORTS) {
  for (const route of PAGES) {
    test(`${route} @ ${vp.name}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await mock(page);
      const consoleErrors: string[] = [];
      page.on("console", (m) => { if (m.type() === "error" && !/status of 40[14]/.test(m.text())) consoleErrors.push(m.text().slice(0, 160)); });
      await page.goto(route, { waitUntil: "networkidle" }).catch(() => undefined);
      await page.waitForTimeout(1200);
      const name = `${route.replace(/\//g, "_") || "_root"}-${vp.name}`;
      await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });

      const layout = await page.evaluate(() => {
        const W = window.innerWidth;
        const doc = document.documentElement;
        const overflowX = doc.scrollWidth - doc.clientWidth;
        const offscreen: string[] = [];
        const clipped: string[] = [];
        for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          const cs = getComputedStyle(el);
          if (cs.visibility === "hidden" || cs.display === "none") continue;
          // Inside a box that scrolls sideways on its own, a wide table is fine.
          let scrolled = false;
          for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
            const o = getComputedStyle(a).overflowX;
            if (o === "auto" || o === "scroll" || o === "hidden") { scrolled = true; break; }
          }
          if (r.right > W + 2 && !scrolled && cs.position !== "fixed") {
            offscreen.push(`${el.tagName.toLowerCase()}.${(el.className?.toString() || "").slice(0, 40)} right=${Math.round(r.right)}`);
          }
          if (el.scrollWidth > el.clientWidth + 2 && (cs.overflow === "hidden" || cs.textOverflow === "ellipsis") && el.clientWidth > 0) {
            clipped.push(`${el.tagName.toLowerCase()}: "${(el.textContent || "").trim().slice(0, 50)}"`);
          }
        }
        return { overflowX, offscreen: offscreen.slice(0, 12), offscreenCount: offscreen.length, clipped: clipped.slice(0, 12), clippedCount: clipped.length };
      });
      findings.push({ page: route, viewport: vp.name, ...layout, consoleErrors: consoleErrors.slice(0, 5) });
    });
  }
}

test.afterAll(() => {
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(findings, null, 2));
});
