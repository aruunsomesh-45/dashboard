// Metric-by-metric audit of every dashboard number. Seeds one brand with a known dataset (including the
// edge cases: discounts, refunds, partial refunds, voided and cancelled orders, a previous period, ad facts
// inside and outside the window, failed payments, NDR / RTO shipments), calls the REAL API routes, and
// compares each metric with a value worked out by hand below. Prints a PASS/FAIL table; fails if any metric
// is wrong. [REAL route code + LOCAL PGlite DB]
import { assertEquals } from "jsr:@std/assert@1";
import { hit, WebWorld } from "./harness.ts";

const opts = { sanitizeResources: false, sanitizeOps: false };

Deno.test({ ...opts, name: "Dashboard metrics audit", fn: async () => {
  const ww = await WebWorld.create();
  const w = ww.w;
  const api = await import("../../../frontend/src/app/api/[[...path]]/route.ts");
  const M = await ww.tenant("metrics-owner@example.test", "Metrics Org");
  const base = `/api/w/${M.slug}/b/${M.brand_id}`;
  const cookies = { "sb-access-token": M.token };
  const ago = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();

  // ── Shopify orders (minor units). gross_amount = net + tax + shipping, as the mapper stores it. ──────────
  const order = (id: string, net: number, disc: number, tax: number, ship: number, fin: string, ful: string, d: number, cancelled = false) =>
    w.db.query(
      `INSERT INTO public.commerce_order (workspace_id, brand_id, provider, provider_id, order_number, gross_amount, discount_amount, tax_amount, shipping_amount, net_sales, financial_status, fulfillment_status, source_created_at, cancelled_at)
       VALUES ($1,$2,'shopify',$3,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [M.workspace_id, M.brand_id, id, net + tax + ship, disc, tax, ship, net, fin, ful, ago(d), cancelled ? ago(d) : null]);
  await order("#O1", 10000, 1000, 1800, 500, "paid", "fulfilled", 2);
  await order("#O2", 20000, 0, 3600, 0, "paid", "unfulfilled", 3);
  await order("#O3", 5000, 500, 900, 500, "pending", "partial", 4);
  await order("#O4", 8000, 0, 1440, 0, "refunded", "fulfilled", 5);
  await order("#O5", 3000, 0, 540, 0, "voided", "unfulfilled", 6);
  await order("#O6", 7000, 0, 1260, 0, "paid", "unfulfilled", 7, true); // cancelled
  await order("#O7", 12000, 200, 2160, 300, "partially_refunded", "fulfilled", 8);
  await order("#P1", 25000, 0, 4500, 0, "paid", "fulfilled", 40); // previous 30-day window
  await order("#P2", 14000, 0, 2520, 0, "paid", "fulfilled", 50); // previous 30-day window

  // ── Razorpay payment attempts ─────────────────────────────────────────────────────────────────────────
  await w.db.query(
    `INSERT INTO public.commerce_paymentattempt (workspace_id, brand_id, provider, provider_id, amount_minor, status, method, source_created_at) VALUES
       ($1,$2,'razorpay','pay_a',50000,'captured','upi',now()), ($1,$2,'razorpay','pay_b',30000,'captured','card',now()),
       ($1,$2,'razorpay','pay_c',20000,'captured','upi',now()), ($1,$2,'razorpay','pay_d',10000,'captured','netbanking',now()),
       ($1,$2,'razorpay','pay_e',15000,'failed','card',now()),  ($1,$2,'razorpay','pay_f',5000,'failed','upi',now())`,
    [M.workspace_id, M.brand_id]);

  // ── Meta daily account facts: two inside 30 days, one outside ─────────────────────────────────────────
  await w.db.query(
    `INSERT INTO public.analytics_factadsdaily (workspace_id, brand_id, fact_date, spend_minor, impressions, clicks, attributed_conversions, attributed_revenue_minor) VALUES
       ($1,$2,current_date - 1, 10000, 20000, 400, 3, 45000),
       ($1,$2,current_date - 10, 6000, 10000, 150, 1, 9000),
       ($1,$2,current_date - 45, 4000, 5000, 50, 0, 0)`,
    [M.workspace_id, M.brand_id]);
  await w.addIntegration(M, "meta_ads", { ad_account_id: "act_9", access_token: "EAAB_synthetic" }, "act_9");

  // ── Shipments ─────────────────────────────────────────────────────────────────────────────────────────
  const ship = (id: string, status: string, ndr: number, shipped: number | null, delivered: number | null) =>
    w.db.query(
      `INSERT INTO public.commerce_shipment (workspace_id, brand_id, provider, provider_id, awb, courier_name, canonical_status, ndr_count, shipped_at, delivered_at)
       VALUES ($1,$2,'delhivery',$3,$3,'Delhivery',$4,$5,$6,$7)`,
      [M.workspace_id, M.brand_id, id, status, ndr, shipped == null ? null : ago(shipped), delivered == null ? null : ago(delivered)]);
  await ship("AWB1", "delivered", 0, 5, 2); // 3 days
  await ship("AWB2", "delivered", 0, 6, 2); // 4 days
  await ship("AWB3", "in_transit", 0, 1, null);
  await ship("AWB4", "out_for_delivery", 1, 2, null);
  await ship("AWB5", "rto_initiated", 2, 6, null);
  await ship("AWB6", "rto_delivered", 0, 9, null);

  const get = async (path: string) => {
    const r = await hit(api, `${base}/${path}`, { cookies });
    assertEquals(r.status, 200, path);
    return r.body;
  };
  const shop = await get("shopify/stats/?days=30");
  const ov = await get("metrics/?days=30");
  const pnl = await get("pnl/?days=30");
  const pay = await get("payments/stats");
  const txn = await get("payments/transactions?limit=100");
  const mkt = await get("marketing/stats");
  const log = await get("logistics/summary");
  const ships = await get("logistics/shipments?limit=100");

  // Hand-worked expectations (window = last 30 days):
  //   valid (not cancelled/voided) = O1 O2 O3 O4 O7; refunded = O4; kept = O1 O2 O3 O7
  //   discounts 1000+500+200 = 1700; gross = (10000+20000+5000+8000+12000) + 1700 = 56700
  //   refunds 8000; net = 56700 - 1700 - 8000 = 47000; orders 4; AOV 11750
  //   previous window: net 39000, 2 orders, AOV 19500
  //   ads in 30d: spend 16000, impr 30000, clicks 550, conv 4, rev 54000; lifetime adds 4000/5000/50
  const rows: Array<[string, string, string, unknown, unknown]> = [];
  const check = (app: string, page: string, metric: string, actual: unknown, expected: unknown) =>
    rows.push([app, page, metric, actual, expected]);

  const m = shop.metrics;
  check("Shopify", "Shopify Store", "Net Sales", m.net_sales_minor, 47000);
  check("Shopify", "Shopify Store", "Gross Sales", m.gross_sales_minor, 56700);
  check("Shopify", "Shopify Store", "Discounts", m.discount_total_minor, 1700);
  check("Shopify", "Shopify Store", "Refunds", m.refunds_minor, 8000);
  check("Shopify", "Shopify Store", "Orders", m.order_count, 4);
  check("Shopify", "Shopify Store", "AOV", m.aov_minor, 11750);
  check("Shopify", "Shopify Store", "Tax collected", m.tax_total_minor, 1800 + 3600 + 900 + 2160);
  check("Shopify", "Shopify Store", "Shipping charged", m.shipping_total_minor, 500 + 0 + 500 + 300);
  check("Shopify", "Shopify Store", "Order total (customer paid)", m.order_total_minor, 12300 + 23600 + 6400 + 14460);
  check("Shopify", "Shopify Store", "Refunded order count", m.refunded_order_count, 1);
  check("Shopify", "Shopify Store", "Partially refunded count", m.partially_refunded_order_count, 1);
  check("Shopify", "Shopify Store", "Net Sales % vs previous", shop.change_pct.net_sales, 20.5); // (47000-39000)/39000
  check("Shopify", "Shopify Store", "AOV % vs previous", shop.change_pct.aov, -39.7); // (11750-19500)/19500
  check("Shopify", "Shopify Store", "Orders % vs previous", shop.change_pct.orders, 100);
  check("Shopify", "Shopify Store", "Funnel: placed", shop.funnel.placed, 4);
  check("Shopify", "Shopify Store", "Funnel: paid", shop.funnel.paid, 2);
  check("Shopify", "Shopify Store", "Funnel: fulfilled", shop.funnel.fulfilled, 2);
  check("Shopify", "Shopify Store", "Funnel: partial", shop.funnel.partial, 1);
  check("Shopify", "Shopify Store", "Funnel: unfulfilled", shop.funnel.unfulfilled, 1);
  check("Shopify", "Shopify Store", "Recent orders listed (incl. cancelled/voided)", shop.orders.length, 7);

  check("Razorpay", "Payments", "Captured payments", pay.payment_count, 4);
  check("Razorpay", "Payments", "Total attempts", pay.attempt_count, 6);
  check("Razorpay", "Payments", "Success rate %", pay.authorized_rate, 66.7);
  check("Razorpay", "Payments", "Total captured", pay.total_captured_minor, 110000);
  check("Razorpay", "Payments", "Method split", JSON.stringify(pay.method_splits), JSON.stringify({ upi: 50, card: 25, netbanking: 25 }));
  check("Razorpay", "Payments", "Fees (not synced -> null)", pay.total_fees_minor, null);
  check("Razorpay", "Payments", "Transactions listed", txn.length, 6);

  const s30 = mkt.summary_30d, life = mkt.summary_lifetime;
  check("Meta Ads", "Marketing", "Spend (30d)", s30.spend_minor, 16000);
  check("Meta Ads", "Marketing", "Impressions (30d)", s30.impressions, 30000);
  check("Meta Ads", "Marketing", "Clicks (30d)", s30.clicks, 550);
  check("Meta Ads", "Marketing", "CTR % (30d)", s30.ctr, 1.83); // 550/30000
  check("Meta Ads", "Marketing", "CPC (30d)", s30.cpc_minor, 29); // 16000/550
  check("Meta Ads", "Marketing", "CPM (30d)", s30.cpm_minor, 533); // 16000/30000*1000
  check("Meta Ads", "Marketing", "Purchases (30d)", s30.orders, 4);
  check("Meta Ads", "Marketing", "Attributed revenue (30d)", s30.attributed_revenue_minor, 54000);
  check("Meta Ads", "Marketing", "ROAS (30d)", s30.roas, 3.38); // 54000/16000 = 3.375
  check("Meta Ads", "Marketing", "Spend (lifetime)", life.spend_minor, 20000);
  check("Meta Ads", "Marketing", "CTR % (lifetime)", life.ctr, 1.71); // 600/35000
  check("Meta Ads", "Marketing", "ROAS (lifetime)", life.roas, 2.7);
  check("Meta Ads", "Marketing", "Daily trend rows (30d)", mkt.daily_trends.length, 2);
  check("Meta Ads", "Marketing", "Daily ROAS (yesterday)", mkt.daily_trends.at(-1)?.roas, 4.5);

  check("Shopify + Meta", "Overview", "Blended ROAS", ov.metrics.blended_roas.value, 2.94); // 47000/16000
  check("Shopify", "Overview", "Orders to be shipped (paid + unfulfilled)", ov.metrics.orders_to_be_shipped.value, 1);
  check("—", "Overview", "Blended CAC (not available)", ov.metrics.blended_cac.available, false);
  check("—", "Overview", "Delivery success % (not available)", ov.metrics.delivery_success_pct.available, false);
  check("—", "Overview", "Disputes (not available)", ov.metrics.number_of_disputes.available, false);
  check("—", "Overview", "Organic engagement (not available)", ov.metrics.organic_engagement.available, false);

  const l = pnl.lines, p = pnl.pct_of_net;
  check("Shopify", "P&L", "Gross sales", l.gross_sales_minor, 56700);
  check("Shopify", "P&L", "Discounts", l.discounts_minor, 1700);
  check("Shopify", "P&L", "Refunds", l.refunds_minor, 8000);
  check("Shopify", "P&L", "Net revenue", l.net_revenue_minor, 47000);
  check("Estimate", "P&L", "COGS (35%)", l.cogs_minor, 16450);
  check("Estimate", "P&L", "Gross margin", l.gross_margin_minor, 30550);
  check("Meta Ads", "P&L", "Ad spend (30d)", l.ad_spend_minor, 16000);
  check("Estimate", "P&L", "Gateway charges (2%)", l.gateway_charges_minor, 940);
  check("Estimate", "P&L", "Shipping costs (Rs 75 x 4)", l.shipping_costs_minor, 30000);
  check("Calculated", "P&L", "CM1", l.cm1_minor, 30550 - 16000 - 940 - 30000);
  check("—", "P&L", "EBITDA (not tracked -> null)", l.ebitda_minor, null);
  check("Calculated", "P&L", "Gross sales % of net", p.gross_sales, 120.6);
  check("Calculated", "P&L", "Refunds % of net", p.refunds, 17);
  check("Calculated", "P&L", "Ad spend % of net", p.ad_spend, 34);
  check("Calculated", "P&L", "Shipping % of net", p.shipping_costs, 63.8);
  check("Calculated", "P&L", "CM1 % of net", p.cm1, -34.9);
  check("Shopify", "P&L", "Memo: tax collected", pnl.memo.tax_collected_minor, 8460);
  check("Shopify", "P&L", "Memo: shipping charged", pnl.memo.shipping_charged_minor, 1300);

  check("Delhivery", "Logistics", "Total shipments", log.total_shipments, 6);
  check("Delhivery", "Logistics", "In transit", log.in_transit_count, 2);
  check("Delhivery", "Logistics", "Delivered", log.delivered_count, 2);
  check("Delhivery", "Logistics", "NDR count", log.ndr_count, 2);
  check("Delhivery", "Logistics", "NDR %", log.ndr_rate_percentage, 33.3);
  check("Delhivery", "Logistics", "RTO %", log.rto_rate_percentage, 33.3);
  check("Delhivery", "Logistics", "Avg delivery days", log.avg_delivery_days, 3.5);
  check("Delhivery", "Logistics", "Shipments listed", ships.length, 6);

  const same = (a: unknown, b: unknown) => (typeof a === "number" && typeof b === "number" ? Math.abs(a - b) < 1e-9 : a === b);
  const failed = rows.filter(([, , , a, e]) => !same(a, e));
  console.log("\nAPP\tPAGE\tMETRIC\tAPI\tEXPECTED\tRESULT");
  for (const [app, page, metric, a, e] of rows) console.log([app, page, metric, a, e, same(a, e) ? "PASS" : "FAIL"].join("\t"));
  console.log(`\n${rows.length - failed.length}/${rows.length} passed`);
  assertEquals(failed.map(([, page, metric]) => `${page}: ${metric}`), []);
}});
