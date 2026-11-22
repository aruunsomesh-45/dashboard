// Edge Function handlers end-to-end: auth -> workspace check -> credential decrypt -> upstream API
// -> normalise -> persist -> sync history.
// [MOCKED upstream APIs (scripted fetch, synthetic payloads) + LOCAL DB (real schema/RLS via PGlite)]
// These tests prove the code path and persistence logic. They do NOT prove live connectivity.
import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";
import { call, json, type Tenant, World } from "../helpers/world.ts";
import { metaInsightDay, razorpayPayment, shopifyOrder } from "../helpers/payloads.ts";
import { createHandler as shopifySync } from "../../supabase/functions/shopify-sync/handler.ts";
import { createHandler as razorpaySync } from "../../supabase/functions/razorpay-sync/handler.ts";
import { createHandler as metaSync } from "../../supabase/functions/meta-ads-sync/handler.ts";
import { createHandler as igSync } from "../../supabase/functions/instagram-sync/handler.ts";
import { createHandler as testConn } from "../../supabase/functions/test-connection/handler.ts";

const opts = { sanitizeResources: false, sanitizeOps: false };

async function freshWorld() {
  const w = await World.create();
  const A = await w.signUp("owner-a@example.test", "Org A");
  const B = await w.signUp("owner-b@example.test", "Org B");
  return { w, A, B };
}
const body = (t: Tenant, extra: Record<string, unknown> = {}) => ({ workspace_id: t.workspace_id, brand_id: t.brand_id, ...extra });

// ───────────────────────────────── SHOPIFY ─────────────────────────────────
Deno.test({ ...opts, name: "Shopify sync", fn: async (t) => {
  const { w, A } = await freshWorld();
  const integ = await w.addIntegration(A, "shopify", { shop_domain: "test-store.myshopify.com", access_token: "shpat_synthetic" });
  const h = () => shopifySync(w.deps());

  await t.step("fetches 2 pages via Link header, persists orders, customers, lines, sync run", async () => {
    w.http.on(/test-store\.myshopify\.com\/admin\/api\/2024-10\/orders\.json\?status=any/, () =>
      json({ orders: [shopifyOrder(1), shopifyOrder(2)] }, 200, {
        Link: '<https://test-store.myshopify.com/admin/api/2024-10/orders.json?limit=250&page_info=p2>; rel="next"',
        "X-Shopify-Shop-Api-Call-Limit": "39/40",
      }));
    w.http.on(/page_info=p2/, () => json({ orders: [shopifyOrder(3)] }));
    const r = await call(h(), "shopify-sync", { token: A.token, body: body(A) });
    assertEquals(r.status, 200, JSON.stringify(r.body));
    assertEquals(r.body.data.status, "success");
    assertEquals(r.body.data.records_processed, 3);
    assertEquals(r.body.data.records_created, 3);
    assertEquals(r.body.data.pages_fetched, 2);
    assertEquals(await w.count("commerce_order", "brand_id=$1", [A.brand_id]), 3);
    assertEquals(await w.count("commerce_customer", "brand_id=$1", [A.brand_id]), 3);
    assertEquals(await w.count("commerce_orderline"), 6);
    // token header sent, only to the shop host
    assert(w.http.calls.every((c) => new URL(c.url).host === "test-store.myshopify.com"));
    assertEquals(w.http.calls[0].headers.get("X-Shopify-Access-Token"), "shpat_synthetic");
    // leaky-bucket back-off at 39/40
    assert(w.sleeps.includes(1000));
    const [run] = await w.rows<any>("select status, records_processed, records_created, finished_at from integrations_syncrun where integration_id=$1", [integ]);
    assertEquals([run.status, run.records_processed, run.records_created], ["success", 3, 3]);
    assert(run.finished_at);
    const [o] = await w.rows<any>("select gross_amount, net_sales, financial_status, fulfillment_status, customer_id from commerce_order where provider_id='1'");
    assertEquals([Number(o.gross_amount), Number(o.net_sales), o.financial_status, o.fulfillment_status], [118000, 100000, "paid", "unfulfilled"]);
    assert(o.customer_id);
  });

  await t.step("re-sync is idempotent: no duplicate orders/lines, counts as updates", async () => {
    w.http.routes = [];
    w.http.on(/orders\.json/, () => json({ orders: [shopifyOrder(1, { financial_status: "refunded" }), shopifyOrder(2)] }));
    const r = await call(h(), "shopify-sync", { token: A.token, body: body(A) });
    assertEquals(r.body.data.records_created, 0);
    assertEquals(r.body.data.records_updated, 2);
    assertEquals(await w.count("commerce_order", "brand_id=$1", [A.brand_id]), 3);
    assertEquals(await w.count("commerce_orderline"), 6);
    assertEquals((await w.rows<any>("select financial_status from commerce_order where provider_id='1'"))[0].financial_status, "refunded");
  });

  await t.step("empty API response -> success with 0 records", async () => {
    w.http.routes = [];
    w.http.on(/orders\.json/, () => json({ orders: [] }));
    const r = await call(h(), "shopify-sync", { token: A.token, body: body(A) });
    assertEquals([r.status, r.body.data.records_processed], [200, 0]);
  });

  await t.step("one bad order -> partial (others saved, failure counted, not silently 'success')", async () => {
    w.http.routes = [];
    w.http.on(/orders\.json/, () => json({ orders: [shopifyOrder(10), { total_price: "1.00" } /* no id */] }));
    const r = await call(h(), "shopify-sync", { token: A.token, body: body(A) });
    assertEquals(r.body.data.status, "partial");
    assertEquals(r.body.data.records_failed, 1);
  });

  await t.step("expired/invalid token (401) -> 502, integration marked error, sync run failed", async () => {
    w.http.routes = [];
    w.http.on(/orders\.json/, () => json({ errors: "[API] Invalid API key or access token" }, 401));
    const r = await call(h(), "shopify-sync", { token: A.token, body: body(A) });
    assertEquals(r.status, 502);
    assertMatch(r.body.error, /Invalid API key/);
    const [i] = await w.rows<any>("select status, last_error_message from integrations_integration where id=$1", [integ]);
    assertEquals(i.status, "error");
    const [run] = await w.rows<any>("select status, error_message from integrations_syncrun where integration_id=$1 order by started_at desc limit 1", [integ]);
    assertEquals(run.status, "failed");
  });

  await t.step("429 rate limit -> retried after Retry-After, then succeeds", async () => {
    w.http.routes = [];
    w.sleeps = [];
    w.http.on(/orders\.json/, (_u, n) => n === 1 ? json({ errors: "Exceeded 2 calls per second" }, 429, { "Retry-After": "2.0" }) : json({ orders: [shopifyOrder(20)] }));
    const r = await call(h(), "shopify-sync", { token: A.token, body: body(A) });
    assertEquals(r.status, 200);
    assert(w.sleeps.includes(2000));
  });

  await t.step("malformed upstream JSON -> 502, not a crash", async () => {
    w.http.routes = [];
    w.http.on(/orders\.json/, () => new Response("<html>gateway</html>", { status: 200 }));
    const r = await call(h(), "shopify-sync", { token: A.token, body: body(A) });
    assertEquals(r.status, 502);
  });

  await t.step("upstream timeout -> 504", async () => {
    w.http.routes = [];
    w.http.on(/orders\.json/, () => { throw new DOMException("timed out", "AbortError"); });
    const r = await call(h(), "shopify-sync", { token: A.token, body: body(A) });
    assertEquals(r.status, 504);
  });

  await t.step("Link header pointing at another host is not followed (token never leaves Shopify)", async () => {
    w.http.routes = [];
    w.http.calls = [];
    w.http.on(/orders\.json/, () => json({ orders: [] }, 200, { Link: '<https://attacker.example/steal>; rel="next"' }));
    const r = await call(h(), "shopify-sync", { token: A.token, body: body(A) });
    assertEquals([r.status, r.body.data.pages_fetched, w.http.calls.length], [200, 1, 1]);
  });

  await t.step("integration not configured -> 404; shpss_ secret stored instead of token -> 400", async () => {
    const C = await w.signUp("owner-c@example.test", "Org C");
    assertEquals((await call(h(), "shopify-sync", { token: C.token, body: body(C) })).status, 404);
    await w.addIntegration(C, "shopify", { shop_domain: "c.myshopify.com", access_token: "shpss_wrong" });
    const r = await call(h(), "shopify-sync", { token: C.token, body: body(C) });
    assertEquals(r.status, 400);
    assertMatch(r.body.error, /shpss_/);
  });

  await w.close();
}});

// ───────────────────────────────── RAZORPAY ─────────────────────────────────
Deno.test({ ...opts, name: "Razorpay sync", fn: async (t) => {
  const { w, A } = await freshWorld();
  const integ = await w.addIntegration(A, "razorpay", { key_id: "rzp_test_SYNTH", key_secret: "synthetic_secret", webhook_secret: "wh" });
  const h = () => razorpaySync(w.deps());

  await t.step("Basic auth sent; paginates with count/skip; persists normalised payments", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => razorpayPayment(`pay_P1${String(i).padStart(4, "0")}`, i % 3 === 0 ? { status: "failed", method: "card" } : {}));
    w.http.on(/api\.razorpay\.com\/v1\/payments\?count=100&skip=0/, () => json({ entity: "collection", count: 100, items: page1 }));
    w.http.on(/skip=100/, () => json({ entity: "collection", count: 2, items: [razorpayPayment("pay_P2A"), razorpayPayment("pay_P2B", { status: "refunded", method: "paylater" })] }));
    const r = await call(h(), "razorpay-sync", { token: A.token, body: body(A) });
    assertEquals(r.status, 200, JSON.stringify(r.body));
    assertEquals([r.body.data.records_processed, r.body.data.records_created, r.body.data.pages_fetched], [102, 102, 2]);
    assertEquals(w.http.calls[0].headers.get("Authorization"), `Basic ${btoa("rzp_test_SYNTH:synthetic_secret")}`);
    assertEquals(await w.count("commerce_paymentattempt", "brand_id=$1", [A.brand_id]), 102);
    const rows = await w.rows<any>("select status, method, amount_minor from commerce_paymentattempt where provider_id in ('pay_P2B','pay_P10000') order by provider_id");
    assertEquals(rows.map((x) => [x.status, x.method, Number(x.amount_minor)]), [["failed", "card", 118000], ["refunded", "other", 118000]]);
    const [run] = await w.rows<any>("select status, resource from integrations_syncrun where integration_id=$1", [integ]);
    assertEquals([run.status, run.resource], ["success", "payments"]);
  });

  await t.step("duplicate prevention: re-sync updates in place", async () => {
    w.http.routes = [];
    w.http.on(/payments/, () => json({ items: [razorpayPayment("pay_P2A", { status: "refunded" })] }));
    const r = await call(h(), "razorpay-sync", { token: A.token, body: body(A) });
    assertEquals([r.body.data.records_created, r.body.data.records_updated], [0, 1]);
    assertEquals(await w.count("commerce_paymentattempt", "brand_id=$1", [A.brand_id]), 102);
  });

  await t.step("bad API key (401) -> 502 + integration error", async () => {
    w.http.routes = [];
    w.http.on(/payments/, () => json({ error: { code: "BAD_REQUEST_ERROR", description: "The api key provided is invalid" } }, 401));
    const r = await call(h(), "razorpay-sync", { token: A.token, body: body(A) });
    assertEquals(r.status, 502);
    assertMatch(r.body.error, /api key provided is invalid/);
    assertEquals((await w.rows<any>("select status from integrations_integration where id=$1", [integ]))[0].status, "error");
  });

  await t.step("missing items array -> 502 (response validation)", async () => {
    w.http.routes = [];
    w.http.on(/payments/, () => json({ entity: "collection" }));
    assertEquals((await call(h(), "razorpay-sync", { token: A.token, body: body(A) })).status, 502);
  });

  await w.close();
}});

// ───────────────────────────────── META ADS ─────────────────────────────────
Deno.test({ ...opts, name: "Meta Ads sync", fn: async (t) => {
  const { w, A } = await freshWorld();
  const integ = await w.addIntegration(A, "meta_ads", { ad_account_id: "1234567890", access_token: "EAAB_synthetic" });
  const h = () => metaSync(w.deps());

  await t.step("follows paging.next on graph.facebook.com and upserts daily facts", async () => {
    w.http.on(/graph\.facebook\.com\/v21\.0\/act_1234567890\/insights\?level=account/, () =>
      json({ data: [metaInsightDay("2026-11-01"), metaInsightDay("2026-11-02")], paging: { next: "https://graph.facebook.com/v21.0/act_1234567890/insights?after=CUR2" } }));
    w.http.on(/after=CUR2/, () => json({ data: [metaInsightDay("2026-11-03", { spend: "0", actions: [] })], paging: {} }));
    const r = await call(h(), "meta-ads-sync", { token: A.token, body: body(A) });
    assertEquals(r.status, 200, JSON.stringify(r.body));
    assertEquals([r.body.data.records_processed, r.body.data.records_created, r.body.data.pages_fetched], [3, 3, 2]);
    const rows = await w.rows<any>("select fact_date::text d, spend_minor, attributed_conversions, attributed_revenue_minor from analytics_factadsdaily where brand_id=$1 order by fact_date", [A.brand_id]);
    assertEquals(rows.map((x) => [x.d, Number(x.spend_minor), x.attributed_conversions, Number(x.attributed_revenue_minor)]), [
      ["2026-11-01", 150025, 6, 720000],
      ["2026-11-02", 150025, 6, 720000],
      ["2026-11-03", 0, 0, 720000],
    ]);
    // time_range is proper JSON, not single-quoted pseudo-JSON
    const tr = new URL(w.http.calls[0].url).searchParams.get("time_range")!;
    assertEquals(Object.keys(JSON.parse(tr)), ["since", "until"]);
  });

  await t.step("re-sync updates days in place (unique brand_id+fact_date)", async () => {
    w.http.routes = [];
    w.http.on(/insights/, () => json({ data: [metaInsightDay("2026-11-01", { spend: "10.00" })] }));
    const r = await call(h(), "meta-ads-sync", { token: A.token, body: body(A) });
    assertEquals([r.body.data.records_created, r.body.data.records_updated], [0, 1]);
    assertEquals(await w.count("analytics_factadsdaily", "brand_id=$1", [A.brand_id]), 3);
  });

  await t.step("expired token (code 190) -> 502 token_invalid, integration error", async () => {
    w.http.routes = [];
    w.http.on(/insights/, () => json({ error: { message: "Error validating access token: Session has expired", type: "OAuthException", code: 190, error_subcode: 463 } }, 400));
    const r = await call(h(), "meta-ads-sync", { token: A.token, body: body(A) });
    assertEquals(r.status, 502);
    assertEquals(r.body.details.meta_error_kind, "token_invalid");
    assertMatch((await w.rows<any>("select last_error_message from integrations_integration where id=$1", [integ]))[0].last_error_message, /invalid or expired/);
  });

  await t.step("missing ads_read permission (code 200) -> permission error", async () => {
    w.http.routes = [];
    w.http.on(/insights/, () => json({ error: { message: "(#200) Requires ads_read permission", code: 200 } }, 403));
    const r = await call(h(), "meta-ads-sync", { token: A.token, body: body(A) });
    assertEquals(r.body.details.meta_error_kind, "permission");
  });

  await t.step("paging.next on a foreign host is ignored (token is in the query string)", async () => {
    w.http.routes = [];
    w.http.calls = [];
    w.http.on(/insights/, () => json({ data: [], paging: { next: "https://evil.example/collect?access_token=x" } }));
    const r = await call(h(), "meta-ads-sync", { token: A.token, body: body(A) });
    assertEquals([r.status, w.http.calls.length], [200, 1]);
  });

  await w.close();
}});

// ───────────────────────────────── INSTAGRAM ─────────────────────────────────
Deno.test({ ...opts, name: "Instagram sync", fn: async (t) => {
  const { w, A } = await freshWorld();
  const integ = await w.addIntegration(A, "instagram", { graph_token: "EAAB_ig_synthetic" });
  const h = () => igSync(w.deps());

  await t.step("full permissions: token, account discovery, media", async () => {
    w.http.on(/\/v21\.0\/me\?/, () => json({ id: "10", name: "Brand Page Admin" }));
    w.http.on(/\/me\/accounts\?/, () => json({ data: [{ id: "P1", name: "Page", instagram_business_account: { id: "1784", username: "brand", followers_count: 1200, media_count: 40 } }] }));
    w.http.on(/\/1784\/media\?/, () => json({ data: [{ id: "m1" }, { id: "m2" }] }));
    const r = await call(h(), "instagram-sync", { token: A.token, body: body(A) });
    assertEquals(r.status, 200, JSON.stringify(r.body));
    assertEquals(r.body.data.account_info.instagram.username, "brand");
    assertEquals([r.body.data.records_fetched, r.body.data.records_persisted], [2, 0]);
    assertEquals((await w.rows<any>("select account_identifier from integrations_integration where id=$1", [integ]))[0].account_identifier, "@brand");
  });

  await t.step("partial permissions: token OK but pages_show_list missing -> reported per capability, not a crash", async () => {
    w.http.routes = [];
    w.http.on(/\/v21\.0\/me\?/, () => json({ id: "10", name: "Admin" }));
    w.http.on(/\/me\/accounts\?/, () => json({ error: { message: "(#200) pages_show_list permission required", code: 200 } }, 403));
    const r = await call(h(), "instagram-sync", { token: A.token, body: body(A) });
    assertEquals(r.status, 200);
    assertEquals(r.body.data.capabilities.account.ok, false);
    assertEquals(r.body.data.account_info.instagram, null);
  });

  await t.step("invalid token -> 502 + integration error", async () => {
    w.http.routes = [];
    w.http.on(/\/me\?/, () => json({ error: { message: "Invalid OAuth access token.", code: 190 } }, 400));
    assertEquals((await call(h(), "instagram-sync", { token: A.token, body: body(A) })).status, 502);
    assertEquals((await w.rows<any>("select status from integrations_integration where id=$1", [integ]))[0].status, "error");
  });

  await w.close();
}});

// ───────────────────────────────── TEST-CONNECTION ─────────────────────────────────
Deno.test({ ...opts, name: "test-connection", fn: async (t) => {
  const { w, A, B } = await freshWorld();
  const h = () => testConn(w.deps());

  await t.step("stored integration: decrypts creds, live-style probe, returns connected", async () => {
    const id = await w.addIntegration(A, "shopify", { shop_domain: "test-store.myshopify.com", access_token: "shpat_synthetic" });
    w.http.on(/test-store\.myshopify\.com\/admin\/api\/2024-10\/shop\.json/, () => json({ shop: { name: "Test Store", myshopify_domain: "test-store.myshopify.com" } }));
    const r = await call(h(), "test-connection", { token: A.token, body: { integration_id: id } });
    assertEquals(r.status, 200);
    assertEquals(r.body.data.connection_status, "connected");
    assertEquals(r.body.data.account_info.name, "Test Store");
  });

  await t.step("another tenant's integration_id -> 404 (no existence oracle)", async () => {
    const id = await w.addIntegration(B, "razorpay", { key_id: "rzp_test_B", key_secret: "s" });
    const r = await call(h(), "test-connection", { token: A.token, body: { integration_id: id } });
    assertEquals(r.status, 404);
  });

  await t.step("ad-hoc credentials: non-Shopify domain is refused before any request (SSRF)", async () => {
    w.http.calls = [];
    const r = await call(h(), "test-connection", { token: A.token, body: { provider: "shopify", credentials: { shop_domain: "169.254.169.254", access_token: "shpat_x" } } });
    assertEquals(r.body.data.connection_status, "failed");
    assertEquals(w.http.calls.length, 0);
  });

  await t.step("shpss_ secret instead of shpat_ token -> clear hint", async () => {
    const r = await call(h(), "test-connection", { token: A.token, body: { provider: "shopify", credentials: { shop_domain: "s.myshopify.com", access_token: "shpss_abc" } } });
    assertMatch(r.body.data.error_message, /shpat_/);
  });

  await t.step("razorpay: 401 -> failed with Razorpay's description; bad key format rejected locally", async () => {
    w.http.on(/api\.razorpay\.com\/v1\/payments\?count=1/, () => json({ error: { description: "Authentication failed" } }, 401));
    const r = await call(h(), "test-connection", { token: A.token, body: { provider: "razorpay", credentials: { key_id: "rzp_test_X", key_secret: "bad" } } });
    assertEquals([r.body.data.connection_status, r.body.data.http_status, r.body.data.error_message], ["failed", 401, "Authentication failed"]);
    const r2 = await call(h(), "test-connection", { token: A.token, body: { provider: "razorpay", credentials: { key_id: "not-a-key", key_secret: "x" } } });
    assertEquals(r2.body.data.http_status, 400);
  });

  await t.step("meta: expired token classified", async () => {
    w.http.on(/graph\.facebook\.com\/v21\.0\/act_42\?/, () => json({ error: { message: "Session has expired", code: 190 } }, 400));
    const r = await call(h(), "test-connection", { token: A.token, body: { provider: "meta_ads", credentials: { ad_account_id: "42", access_token: "EAAB" } } });
    assertMatch(r.body.data.error_message, /token_invalid/);
  });

  await t.step("network failure -> failed result (502), not an unhandled 400/500", async () => {
    w.http.on(/graph\.facebook\.com\/v21\.0\/me\?/, () => { throw new TypeError("getaddrinfo ENOTFOUND"); });
    const r = await call(h(), "test-connection", { token: A.token, body: { provider: "instagram", credentials: { graph_token: "EAAB" } } });
    assertEquals([r.status, r.body.data.connection_status, r.body.data.http_status], [200, "failed", 502]);
  });

  await t.step("unsupported provider -> 400; nothing -> 400", async () => {
    assertEquals((await call(h(), "test-connection", { token: A.token, body: { provider: "paypal" } })).status, 400);
    assertEquals((await call(h(), "test-connection", { token: A.token, body: {} })).status, 400);
  });

  await w.close();
}});
