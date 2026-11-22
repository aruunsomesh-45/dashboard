// SERVICE-LEVEL E2E workflows A-E: signup -> workspace -> connect -> sync/webhook -> DB -> dashboard RPC.
// [MOCKED upstream APIs + LOCAL DB with real schema/RLS/RPCs]
// This is NOT a browser E2E against Vercel; see TEST_REPORT.md for why that is blocked.
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { call, json, World } from "../helpers/world.ts";
import { razorpayPayment, razorpayWebhook, shopifyOrder } from "../helpers/payloads.ts";
import { pgUserClient } from "../helpers/pg_supabase.ts";
import { signRazorpay, signShopify } from "../../supabase/functions/_shared/signatures.ts";
import { createHandler as testConn } from "../../supabase/functions/test-connection/handler.ts";
import { createHandler as shopifySync } from "../../supabase/functions/shopify-sync/handler.ts";
import { createHandler as razorpaySync } from "../../supabase/functions/razorpay-sync/handler.ts";
import { createHandler as shopifyHook } from "../../supabase/functions/webhook-shopify/handler.ts";
import { createHandler as razorpayHook } from "../../supabase/functions/webhook-razorpay/handler.ts";

const opts = { sanitizeResources: false, sanitizeOps: false };
const asUser = (w: World, token: string | null) => pgUserClient(w.db, w.auth, new Request("http://x", { headers: token ? { Authorization: `Bearer ${token}` } : {} }));
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();

Deno.test({ ...opts, name: "E2E workflows", fn: async (t) => {
  const w = await World.create();

  // ── A: AUTHENTICATION ──
  const A = await w.signUp("e2e-owner@example.test", "E2E Brand");
  const OTHER = await w.signUp("e2e-other@example.test", "Other Brand");
  await t.step("A1-A3 register -> authenticate -> workspace auto-provisioned", async () => {
    const me = await asUser(w, A.token).auth.getUser();
    assertEquals(me.data.user.id, A.user.id);
    const ws = await asUser(w, A.token).from("tenancy_workspacemember").select("workspace_id, role");
    assertEquals(ws.data, [{ workspace_id: A.workspace_id, role: "owner" }]);
  });
  await t.step("A4-A6 session verified; protected data blocked without/with wrong session", async () => {
    assertEquals((await asUser(w, null).auth.getUser()).data.user, null);
    assertEquals((await call(shopifySync(w.deps()), "shopify-sync", { body: { workspace_id: A.workspace_id, brand_id: A.brand_id } })).status, 401);
    assertEquals((await call(shopifySync(w.deps()), "shopify-sync", { token: OTHER.token, body: { workspace_id: A.workspace_id, brand_id: A.brand_id } })).status, 403);
  });

  // ── B: SHOPIFY DATA ──
  await t.step("B: connect Shopify -> test creds -> sync -> query saved records", async () => {
    const id = await w.addIntegration(A, "shopify", { shop_domain: "e2e.myshopify.com", access_token: "shpat_e2e", api_secret: "e2e_app_secret" });
    w.http.on(/e2e\.myshopify\.com\/admin\/api\/2024-10\/shop\.json/, () => json({ shop: { name: "E2E Store", myshopify_domain: "e2e.myshopify.com" } }));
    w.http.on(/e2e\.myshopify\.com\/admin\/api\/2024-10\/orders\.json/, () => json({ orders: [
      shopifyOrder(1, { created_at: daysAgo(2) }),
      shopifyOrder(2, { created_at: daysAgo(5), financial_status: "pending", fulfillment_status: "fulfilled" }),
      shopifyOrder(3, { created_at: daysAgo(100) }), // outside a 30-day dashboard window
    ] }));
    const tc = await call(testConn(w.deps()), "test-connection", { token: A.token, body: { integration_id: id } });
    assertEquals(tc.body.data.connection_status, "connected");
    const sync = await call(shopifySync(w.deps()), "shopify-sync", { token: A.token, body: { workspace_id: A.workspace_id, brand_id: A.brand_id, days: 365 } });
    assertEquals([sync.status, sync.body.data.records_created], [200, 3]);
    const mine = await asUser(w, A.token).from("commerce_order").select("provider_id").eq("brand_id", A.brand_id);
    assertEquals(mine.data.length, 3);
  });

  // ── C: RAZORPAY DATA ──
  await t.step("C: Razorpay creds -> fetch payments -> normalise -> persisted values correct", async () => {
    await w.addIntegration(A, "razorpay", { key_id: "rzp_test_E2E", key_secret: "s", webhook_secret: "e2e_rzp_whsec" });
    w.http.on(/api\.razorpay\.com\/v1\/payments\?count=100/, () => json({ items: [razorpayPayment("pay_E2E0000000001"), razorpayPayment("pay_E2E0000000002", { amount: 2500, status: "failed", method: "netbanking" })] }));
    const r = await call(razorpaySync(w.deps()), "razorpay-sync", { token: A.token, body: { workspace_id: A.workspace_id, brand_id: A.brand_id } });
    assertEquals(r.body.data.records_created, 2);
    const rows = await asUser(w, A.token).from("commerce_paymentattempt").select("provider_id, amount_minor, status, method").eq("brand_id", A.brand_id).order("provider_id");
    assertEquals(rows.data, [
      { provider_id: "pay_E2E0000000001", amount_minor: 118000, status: "captured", method: "upi" },
      { provider_id: "pay_E2E0000000002", amount_minor: 2500, status: "failed", method: "netbanking" },
    ]);
  });

  // ── D: WEBHOOKS ──
  await t.step("D: signed Shopify webhook -> persisted -> resend -> duplicate", async () => {
    const body = JSON.stringify(shopifyOrder(4, { created_at: daysAgo(1), total_price: "500.00", total_tax: "0", total_discounts: "0", shipping_lines: [] }));
    const hdr = { "X-Shopify-Topic": "orders/create", "X-Shopify-Hmac-Sha256": await signShopify("e2e_app_secret", body), "X-Shopify-Event-Id": "e2e-evt-4" };
    const first = await call(shopifyHook(w.deps()), "webhook-shopify", { rawBody: body, query: { brand_id: A.brand_id }, headers: hdr });
    const again = await call(shopifyHook(w.deps()), "webhook-shopify", { rawBody: body, query: { brand_id: A.brand_id }, headers: hdr });
    assertEquals([first.status, first.body.data.status, again.body.data.status], [200, "accepted", "duplicate"]);
    assertEquals(await w.count("commerce_order", "brand_id=$1", [A.brand_id]), 4);
  });
  await t.step("D: signed Razorpay webhook -> persisted -> resend -> duplicate", async () => {
    const body = JSON.stringify(razorpayWebhook("payment.captured", razorpayPayment("pay_E2E0000000003", { amount: 9900 })));
    const hdr = { "X-Razorpay-Signature": await signRazorpay("e2e_rzp_whsec", body), "X-Razorpay-Event-Id": "e2e-rzp-1" };
    const first = await call(razorpayHook(w.deps()), "webhook-razorpay", { rawBody: body, query: { brand_id: A.brand_id }, headers: hdr });
    const again = await call(razorpayHook(w.deps()), "webhook-razorpay", { rawBody: body, query: { brand_id: A.brand_id }, headers: hdr });
    assertEquals([first.body.data.status, again.body.data.status], ["accepted", "duplicate"]);
    assertEquals(await w.count("commerce_paymentattempt", "brand_id=$1", [A.brand_id]), 3);
  });

  // ── E: DASHBOARD (the get_brand_commerce_stats RPC the dashboard numbers come from) ──
  await t.step("E: dashboard totals equal an independent SQL aggregate over the same records", async () => {
    const rpc = await asUser(w, A.token).rpc("get_brand_commerce_stats", { p_workspace_id: A.workspace_id, p_brand_id: A.brand_id, p_days: 30 });
    assertEquals(rpc.error, null);
    const [ref] = await w.rows<any>(
      `SELECT count(*)::int n, sum(gross_amount)::bigint gross, sum(net_sales)::bigint net,
              count(*) FILTER (WHERE financial_status='paid')::int paid
         FROM commerce_order WHERE brand_id=$1 AND provider='shopify' AND source_created_at >= now() - interval '30 days'`, [A.brand_id]);
    assertEquals(rpc.data.order_count, ref.n);
    assertEquals(Number(rpc.data.gross_sales_minor), Number(ref.gross));
    assertEquals(Number(rpc.data.net_sales_minor), Number(ref.net));
    assertEquals(rpc.data.paid, ref.paid);
    // concrete expectations from the synthetic data: orders 1, 2, 4 are inside 30 days; 3 is not
    assertEquals(rpc.data.order_count, 3);
    assertEquals(Number(rpc.data.gross_sales_minor), 118000 + 118000 + 50000);
    assertEquals(rpc.data.fulfilled, 1);
  });

  await t.step("E: date filtering - widening the window includes the 100-day-old order", async () => {
    const r = await asUser(w, A.token).rpc("get_brand_commerce_stats", { p_workspace_id: A.workspace_id, p_brand_id: A.brand_id, p_days: 365 });
    assertEquals(r.data.order_count, 4);
  });

  await t.step("E: workspace isolation - another tenant cannot query this dashboard", async () => {
    const r = await asUser(w, OTHER.token).rpc("get_brand_commerce_stats", { p_workspace_id: A.workspace_id, p_brand_id: A.brand_id, p_days: 30 });
    assertNotEquals(r.error, null);
    assert(String(r.error.message).includes("Unauthorized"));
  });

  await t.step("E: empty state - a brand with no data returns zeros, not nulls/errors", async () => {
    const r = await asUser(w, OTHER.token).rpc("get_brand_commerce_stats", { p_workspace_id: OTHER.workspace_id, p_brand_id: OTHER.brand_id, p_days: 30 });
    assertEquals(r.error, null);
    assertEquals([r.data.order_count, Number(r.data.gross_sales_minor), Number(r.data.aov_minor)], [0, 0, 0]);
  });

  await t.step("E: error state - unauthenticated dashboard query is rejected", async () => {
    const r = await asUser(w, null).rpc("get_brand_commerce_stats", { p_workspace_id: A.workspace_id, p_brand_id: A.brand_id, p_days: 30 });
    assertNotEquals(r.error, null);
  });

  await w.close();
}});
