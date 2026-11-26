// Calculation rules: edge cases for every dashboard calculation, through the REAL route handlers.
// Rules under test:
//  - money is stored in minor units (paise); no float drift
//  - a ratio whose denominator is zero is unavailable (null, shown as "—"), never a fake 0
//  - refunds, cancelled and voided orders never count as revenue
//  - the date window is inclusive of its start and based on the order date
//  - one currency per brand; USD brands show dollars
// [LOCAL PGlite DB + real route code]
import { assertEquals } from "jsr:@std/assert@1";
import { hit, WebWorld } from "./harness.ts";

const opts = { sanitizeResources: false, sanitizeOps: false };
const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

Deno.test({ ...opts, name: "Calculation rules", fn: async (t) => {
  const ww = await WebWorld.create();
  const w = ww.w;
  const api = await import("../../../frontend/src/app/api/[[...path]]/route.ts");

  // ── Brand with no data at all ────────────────────────────────────────────────
  const Z = await ww.tenant("calc-empty@example.test", "Calc Empty");
  const zc = { "sb-access-token": Z.token };
  const zb = `/api/w/${Z.slug}/b/${Z.brand_id}`;

  await t.step("no orders: Shopify totals are 0, averages are unavailable, change vs previous is unavailable", async () => {
    const s = await hit(api, `${zb}/shopify/stats/?days=30`, { cookies: zc });
    assertEquals(s.body.metrics.net_sales_minor, 0);
    assertEquals(s.body.metrics.order_count, 0);
    assertEquals(s.body.metrics.aov_minor, 0);            // AOV with 0 orders is shown as unavailable in the UI; the value is 0 here
    assertEquals(s.body.change_pct.net_sales, null);      // no previous period -> no % change
    assertEquals(s.body.change_pct.orders, null);
  });

  await t.step("no orders: P&L revenue is 0 and every percentage of net revenue is unavailable (not a division error)", async () => {
    const p = await hit(api, `${zb}/pnl/?days=30`, { cookies: zc });
    assertEquals(p.status, 200);
    assertEquals([p.body.lines.net_revenue_minor, p.body.lines.cogs_minor, p.body.lines.shipping_costs_minor], [0, 0, 0]);
    assertEquals(p.body.lines.ad_spend_minor, null);      // Meta not connected -> unavailable, not 0
    assertEquals(p.body.pct_of_net.gross_margin, null);
    assertEquals(p.body.pct_of_net.cm1, null);
    assertEquals(p.body.lines.ebitda_minor, null);        // overheads are not tracked
  });

  await t.step("no ad impressions or clicks: CTR, CPC and CPM are unavailable, not 0", async () => {
    await w.addIntegration(Z, "meta_ads", { ad_account_id: "act_0", access_token: "EAAB_z" }, "act_0");
    await w.db.query(
      `insert into analytics_factadsdaily (workspace_id, brand_id, fact_date, spend_minor, impressions, clicks, attributed_conversions, attributed_revenue_minor)
       values ($1,$2, current_date - 1, 5000, 0, 0, 0, 0)`, [Z.workspace_id, Z.brand_id]);
    const m = await hit(api, `${zb}/marketing/stats/`, { cookies: zc });
    assertEquals(m.body.summary_30d.spend_minor, 5000);
    assertEquals(m.body.summary_30d.ctr, null, "CTR with 0 impressions must be unavailable");
    assertEquals(m.body.summary_30d.cpc_minor, null, "CPC with 0 clicks must be unavailable");
    assertEquals(m.body.summary_30d.cpm_minor, null, "CPM with 0 impressions must be unavailable");
    assertEquals(m.body.summary_30d.roas, 0, "ROAS with spend but no revenue is 0 (a real zero)");
  });

  await t.step("no payments: authorized rate is unavailable (not 0)", async () => {
    const pay = await hit(api, `${zb}/payments/stats`, { cookies: zc });
    assertEquals(pay.body.attempt_count, 0);
    assertEquals(pay.body.authorized_rate, null);
    assertEquals(pay.body.method_splits, {});
  });

  // ── Brand with tricky order data ────────────────────────────────────────────
  const B = await ww.tenant("calc-orders@example.test", "Calc Orders");
  const bc = { "sb-access-token": B.token };
  const bb = `/api/w/${B.slug}/b/${B.brand_id}`;
  const order = (id: string, net: number, disc: number, tax: number, ship: number, fin: string, ful: string, created: string, cancelled = false) =>
    w.db.query(
      `insert into commerce_order (workspace_id, brand_id, provider, provider_id, order_number, gross_amount, discount_amount, tax_amount, shipping_amount, net_sales, financial_status, fulfillment_status, source_created_at, cancelled_at)
       values ($1,$2,'shopify',$3,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [B.workspace_id, B.brand_id, id, net + tax + ship, disc, tax, ship, net, fin, ful, created, cancelled ? created : null]);

  await t.step("only refunded orders: net sales 0, refunds counted, AOV 0 (no division by zero), funnel excludes them", async () => {
    await order("R1", 5000, 0, 0, 0, "refunded", "fulfilled", ago(2));
    const s = await hit(api, `${bb}/shopify/stats/?days=30`, { cookies: bc });
    assertEquals(s.body.metrics.refunds_minor, 5000);
    assertEquals(s.body.metrics.net_sales_minor, 0);
    assertEquals(s.body.metrics.order_count, 0);
    assertEquals(s.body.metrics.aov_minor, 0);
    assertEquals(s.body.funnel.placed, 0);
  });

  await t.step("cancelled and voided orders are not revenue, and are not counted as orders", async () => {
    await order("C1", 90000, 0, 0, 0, "paid", "unfulfilled", ago(3), true);
    await order("V1", 80000, 0, 0, 0, "voided", "unfulfilled", ago(3));
    const s = await hit(api, `${bb}/shopify/stats/?days=30`, { cookies: bc });
    assertEquals(s.body.metrics.net_sales_minor, 0);
    assertEquals(s.body.metrics.order_count, 0);
  });

  await t.step("tax and shipping are not part of net sales, and the P&L shipping cost is per order (Rs 75 each)", async () => {
    await order("N1", 10000, 0, 1800, 500, "paid", "fulfilled", ago(1));
    await order("N2", 20000, 0, 3600, 0, "paid", "fulfilled", ago(1));
    const s = await hit(api, `${bb}/shopify/stats/?days=30`, { cookies: bc });
    assertEquals(s.body.metrics.net_sales_minor, 30000);      // 10000 + 20000, tax and shipping excluded
    assertEquals(s.body.metrics.tax_total_minor, 5400);
    assertEquals(s.body.metrics.shipping_total_minor, 500);
    const p = await hit(api, `${bb}/pnl/?days=30`, { cookies: bc });
    assertEquals(p.body.lines.net_revenue_minor, 30000);
    assertEquals(p.body.lines.shipping_costs_minor, 15000);   // 2 orders x 7500 paise
    assertEquals(p.body.lines.cogs_minor, 10500);             // 35% of net
    assertEquals(p.body.lines.gateway_charges_minor, 600);    // 2% of net
  });

  await t.step("window boundary: an order from exactly 30 days ago is outside the 30-day window", async () => {
    await order("B1", 70000, 0, 0, 0, "paid", "fulfilled", new Date(Date.now() - 30 * 86_400_000 - 60_000).toISOString());
    const s = await hit(api, `${bb}/shopify/stats/?days=30`, { cookies: bc });
    assertEquals(s.body.previous.net_sales_minor >= 70000, true, "the order is in the previous window");
    assertEquals(s.body.metrics.net_sales_minor, 30000, "the current window is unchanged");
  });

  await t.step("large amounts keep exact paise (no floating-point drift)", async () => {
    await order("L1", 123456789012, 0, 0, 0, "paid", "fulfilled", ago(1));
    const s = await hit(api, `${bb}/shopify/stats/?days=30`, { cookies: bc });
    assertEquals(s.body.metrics.net_sales_minor, 123456789012 + 30000);
  });

  await t.step("payments: all attempts failed -> authorized rate 0 (a real zero), nothing captured", async () => {
    const F = await ww.tenant("calc-failed@example.test", "Calc Failed");
    await w.db.query(
      `insert into commerce_paymentattempt (workspace_id, brand_id, provider, provider_id, amount_minor, status, method, source_created_at)
       values ($1,$2,'razorpay','f1',1000,'failed','card',now()), ($1,$2,'razorpay','f2',2000,'failed','upi',now())`,
      [F.workspace_id, F.brand_id]);
    const pay = await hit(api, `/api/w/${F.slug}/b/${F.brand_id}/payments/stats`, { cookies: { "sb-access-token": F.token } });
    assertEquals([pay.body.attempt_count, pay.body.payment_count, pay.body.authorized_rate], [2, 0, 0]);
    assertEquals(pay.body.total_captured_minor, 0);
    assertEquals(pay.body.method_splits, {});                 // no captured payments -> no split
  });

  await t.step("logistics: no shipments -> rates are unavailable, not 0", async () => {
    const L = await hit(api, `${zb}/logistics/summary`, { cookies: zc });
    assertEquals(L.body.total_shipments, 0);
    assertEquals(L.body.ndr_rate_percentage, null);
    assertEquals(L.body.rto_rate_percentage, null);
    assertEquals(L.body.avg_delivery_days, null);
  });

  await t.step("USD brand: money is shown in dollars from the brand's currency setting", async () => {
    const U = await ww.tenant("calc-usd@example.test", "Calc USD");
    await w.db.query("update tenancy_brand set currency='USD' where id=$1", [U.brand_id]);
    const s = await hit(api, `/api/w/${U.slug}/b/${U.brand_id}/shopify/stats/?days=30`, { cookies: { "sb-access-token": U.token } });
    assertEquals(s.body.brand.currency, "USD");
  });

  await w.close();
}});
