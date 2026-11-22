// Webhook endpoints: real signature algorithms over raw bytes, idempotency, retry semantics, persistence.
// [SYNTHETIC payloads + LOCAL DB (real schema, dedupe trigger) - signature verification is never bypassed]
import { assert, assertEquals } from "jsr:@std/assert@1";
import { call, World } from "../helpers/world.ts";
import { razorpayPayment, razorpayWebhook, shopifyOrder } from "../helpers/payloads.ts";
import { signRazorpay, signShopify } from "../../supabase/functions/_shared/signatures.ts";
import { createHandler as shopifyHook } from "../../supabase/functions/webhook-shopify/handler.ts";
import { createHandler as razorpayHook } from "../../supabase/functions/webhook-razorpay/handler.ts";
import { pgAdminClient } from "../helpers/pg_supabase.ts";

const opts = { sanitizeResources: false, sanitizeOps: false };
const SHOPIFY_SECRET = "shpss_synthetic_app_secret";
const RZP_WEBHOOK_SECRET = "synthetic_rzp_webhook_secret";

Deno.test({ ...opts, name: "Shopify webhook", fn: async (t) => {
  const w = await World.create();
  const A = await w.signUp("owner-a@example.test", "Org A");
  const B = await w.signUp("owner-b@example.test", "Org B");
  await w.addIntegration(A, "shopify", { shop_domain: "a.myshopify.com", access_token: "shpat_x", api_secret: SHOPIFY_SECRET });
  await w.addIntegration(B, "shopify", { shop_domain: "b.myshopify.com", access_token: "shpat_y", api_secret: "other-secret" });
  const h = () => shopifyHook(w.deps());
  const raw = JSON.stringify(shopifyOrder(777));
  const send = async (body: string, headers: Record<string, string>, brand = A.brand_id) =>
    call(h(), "webhook-shopify", { rawBody: body, query: { brand_id: brand }, headers: { "X-Shopify-Topic": "orders/create", "X-Shopify-Shop-Domain": "a.myshopify.com", ...headers } });

  await t.step("valid HMAC -> 200 accepted, order + lines + event persisted", async () => {
    const r = await send(raw, { "X-Shopify-Hmac-Sha256": await signShopify(SHOPIFY_SECRET, raw), "X-Shopify-Event-Id": "evt-777" });
    assertEquals(r.status, 200, JSON.stringify(r.body));
    assertEquals(r.body.data.status, "accepted");
    assertEquals(await w.count("commerce_order", "brand_id=$1 AND provider_id='777'", [A.brand_id]), 1);
    assertEquals(await w.count("commerce_orderline", "order_id=(select id from commerce_order where provider_id='777')"), 2);
    const [ev] = await w.rows<any>("select topic, processed, raw_body, headers from integrations_webhookevent where event_id='shopify:evt-777'");
    assertEquals([ev.topic, ev.processed, ev.raw_body], ["orders/create", true, raw]);
    assertEquals("x-shopify-hmac-sha256" in ev.headers, false, "signature header is not stored");
  });

  await t.step("duplicate delivery (same event id) -> 200 duplicate, nothing processed twice", async () => {
    const r = await send(raw, { "X-Shopify-Hmac-Sha256": await signShopify(SHOPIFY_SECRET, raw), "X-Shopify-Event-Id": "evt-777" });
    assertEquals(r.body.data.status, "duplicate");
    assertEquals(await w.count("integrations_webhookevent", "event_id='shopify:evt-777'"), 1);
    assertEquals(await w.count("commerce_orderline", "order_id=(select id from commerce_order where provider_id='777')"), 2);
  });

  await t.step("no event-id header -> dedupe falls back to body hash", async () => {
    const body2 = JSON.stringify(shopifyOrder(778));
    const sig = await signShopify(SHOPIFY_SECRET, body2);
    assertEquals((await send(body2, { "X-Shopify-Hmac-Sha256": sig })).body.data.status, "accepted");
    assertEquals((await send(body2, { "X-Shopify-Hmac-Sha256": sig })).body.data.status, "duplicate");
  });

  await t.step("invalid HMAC -> 401, nothing written", async () => {
    const before = await w.count("integrations_webhookevent");
    const r = await send(raw, { "X-Shopify-Hmac-Sha256": await signShopify("wrong-secret", raw), "X-Shopify-Event-Id": "evt-bad" });
    assertEquals(r.status, 401);
    assertEquals(await w.count("integrations_webhookevent"), before);
  });

  await t.step("tampered body with the original signature -> 401", async () => {
    const sig = await signShopify(SHOPIFY_SECRET, raw);
    const r = await send(raw.replace('"1180.00"', '"1.00"'), { "X-Shopify-Hmac-Sha256": sig, "X-Shopify-Event-Id": "evt-tamper" });
    assertEquals(r.status, 401);
  });

  await t.step("missing signature header -> 401", async () => {
    assertEquals((await send(raw, { "X-Shopify-Event-Id": "evt-nosig" })).status, 401);
  });

  await t.step("signature valid for brand A replayed against brand B -> 401 (per-brand secrets)", async () => {
    const r = await send(raw, { "X-Shopify-Hmac-Sha256": await signShopify(SHOPIFY_SECRET, raw), "X-Shopify-Event-Id": "evt-x" }, B.brand_id);
    assertEquals(r.status, 401);
    assertEquals(await w.count("commerce_order", "brand_id=$1", [B.brand_id]), 0);
  });

  await t.step("unknown brand -> 401 (same as bad signature; no brand enumeration)", async () => {
    assertEquals((await send(raw, { "X-Shopify-Hmac-Sha256": "x" }, crypto.randomUUID())).status, 401);
  });

  await t.step("invalid / missing brand_id -> 400", async () => {
    const r = await call(h(), "webhook-shopify", { rawBody: raw, query: { brand_id: "1 OR 1=1" }, headers: { "X-Shopify-Hmac-Sha256": "x" } });
    assertEquals(r.status, 400);
    assertEquals((await call(h(), "webhook-shopify", { rawBody: raw, headers: { "X-Shopify-Hmac-Sha256": "x" } })).status, 400);
  });

  await t.step("validly-signed malformed JSON -> 400", async () => {
    const bad = '{"id": 1, "total_price": ';
    assertEquals((await send(bad, { "X-Shopify-Hmac-Sha256": await signShopify(SHOPIFY_SECRET, bad) })).status, 400);
  });

  await t.step("non-order topic -> accepted + logged, but no order projected", async () => {
    const body = JSON.stringify({ id: 9, title: "Product" });
    const r = await call(h(), "webhook-shopify", { rawBody: body, query: { brand_id: A.brand_id }, headers: { "X-Shopify-Topic": "products/update", "X-Shopify-Hmac-Sha256": await signShopify(SHOPIFY_SECRET, body), "X-Shopify-Event-Id": "evt-prod" } });
    assertEquals(r.body.data.status, "accepted");
    assertEquals(await w.count("commerce_order", "provider_id='9'"), 0);
  });

  await t.step("payload > 1 MiB -> 413", async () => {
    const big = JSON.stringify({ id: 1, pad: "x".repeat(1024 * 1024) });
    assertEquals((await send(big, { "X-Shopify-Hmac-Sha256": "x" })).status, 413);
  });

  await t.step("GET -> 405; OPTIONS preflight -> 200 with CORS headers", async () => {
    assertEquals((await call(h(), "webhook-shopify", { method: "GET", query: { brand_id: A.brand_id } })).status, 405);
    const o = await call(h(), "webhook-shopify", { method: "OPTIONS" });
    assertEquals(o.status, 200);
    assert(o.headers.get("Access-Control-Allow-Headers")?.includes("x-shopify-hmac-sha256"));
  });

  await t.step("RETRY: processing failure -> 500 and NO event logged; provider retry then succeeds", async () => {
    // Simulate a transient DB failure on the order upsert only.
    const failing = w.deps();
    let fail = true;
    failing.adminClient = () => {
      const real = pgAdminClient(w.db);
      return { ...real, from: (tbl: string) => (fail && tbl === "commerce_order" ? { select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: { message: "connection reset", code: "08006" } }) }) }) }) }) } : real.from(tbl)) };
    };
    const body = JSON.stringify(shopifyOrder(901));
    const hdrs = { "X-Shopify-Topic": "orders/create", "X-Shopify-Hmac-Sha256": await signShopify(SHOPIFY_SECRET, body), "X-Shopify-Event-Id": "evt-retry" };
    const first = await call(shopifyHook(failing), "webhook-shopify", { rawBody: body, query: { brand_id: A.brand_id }, headers: hdrs });
    assertEquals(first.status, 500);
    assertEquals(await w.count("integrations_webhookevent", "event_id='shopify:evt-retry'"), 0, "not marked processed");
    fail = false;
    const retry = await call(shopifyHook(failing), "webhook-shopify", { rawBody: body, query: { brand_id: A.brand_id }, headers: hdrs });
    assertEquals(retry.body.data.status, "accepted");
    assertEquals(await w.count("commerce_order", "provider_id='901'"), 1);
  });

  await w.close();
}});

Deno.test({ ...opts, name: "Razorpay webhook", fn: async (t) => {
  const w = await World.create();
  const A = await w.signUp("owner-a@example.test", "Org A");
  await w.addIntegration(A, "razorpay", { key_id: "rzp_test_A", key_secret: "api_secret_not_for_webhooks", webhook_secret: RZP_WEBHOOK_SECRET });
  const h = () => razorpayHook(w.deps());
  const raw = JSON.stringify(razorpayWebhook("payment.captured", razorpayPayment("pay_WH000000000001")));
  const send = async (body: string, headers: Record<string, string>) => call(h(), "webhook-razorpay", { rawBody: body, query: { brand_id: A.brand_id }, headers });

  await t.step("valid X-Razorpay-Signature -> accepted, payment persisted as captured", async () => {
    const r = await send(raw, { "X-Razorpay-Signature": await signRazorpay(RZP_WEBHOOK_SECRET, raw), "X-Razorpay-Event-Id": "EVT_A1" });
    assertEquals(r.status, 200, JSON.stringify(r.body));
    assertEquals(r.body.data.status, "accepted");
    const [p] = await w.rows<any>("select status, amount_minor, method from commerce_paymentattempt where provider_id='pay_WH000000000001'");
    assertEquals([p.status, Number(p.amount_minor), p.method], ["captured", 118000, "upi"]);
    assertEquals(await w.count("integrations_webhookevent", "event_id='razorpay:EVT_A1' AND topic='payment.captured'"), 1);
  });

  await t.step("Razorpay retry with same X-Razorpay-Event-Id -> duplicate", async () => {
    const r = await send(raw, { "X-Razorpay-Signature": await signRazorpay(RZP_WEBHOOK_SECRET, raw), "X-Razorpay-Event-Id": "EVT_A1" });
    assertEquals(r.body.data.status, "duplicate");
    assertEquals(await w.count("commerce_paymentattempt", "provider_id='pay_WH000000000001'"), 1);
  });

  await t.step("later event for same payment (refund) updates the row in place", async () => {
    const body = JSON.stringify(razorpayWebhook("payment.failed", razorpayPayment("pay_WH000000000001", { status: "failed", error_code: "BAD_REQUEST_ERROR" })));
    const r = await send(body, { "X-Razorpay-Signature": await signRazorpay(RZP_WEBHOOK_SECRET, body), "X-Razorpay-Event-Id": "EVT_A2" });
    assertEquals(r.body.data.status, "accepted");
    const [p] = await w.rows<any>("select status, error_code from commerce_paymentattempt where provider_id='pay_WH000000000001'");
    assertEquals([p.status, p.error_code], ["failed", "BAD_REQUEST_ERROR"]);
  });

  await t.step("signed with the API key secret instead of the webhook secret -> 401", async () => {
    const r = await send(raw, { "X-Razorpay-Signature": await signRazorpay("api_secret_not_for_webhooks", raw), "X-Razorpay-Event-Id": "EVT_B" });
    assertEquals(r.status, 401);
  });

  await t.step("invalid / missing signature -> 401", async () => {
    assertEquals((await send(raw, { "X-Razorpay-Signature": "00".repeat(32), "X-Razorpay-Event-Id": "EVT_C" })).status, 401);
    assertEquals((await send(raw, { "X-Razorpay-Event-Id": "EVT_D" })).status, 401);
  });

  await t.step("validly-signed malformed JSON -> 400", async () => {
    const bad = "not json";
    assertEquals((await send(bad, { "X-Razorpay-Signature": await signRazorpay(RZP_WEBHOOK_SECRET, bad) })).status, 400);
  });

  await t.step("non-payment event (settlement) -> accepted and logged, no payment row", async () => {
    const body = JSON.stringify({ event: "settlement.processed", payload: { settlement: { entity: { id: "setl_1" } } } });
    const before = await w.count("commerce_paymentattempt");
    const r = await send(body, { "X-Razorpay-Signature": await signRazorpay(RZP_WEBHOOK_SECRET, body), "X-Razorpay-Event-Id": "EVT_S" });
    assertEquals(r.body.data.status, "accepted");
    assertEquals(await w.count("commerce_paymentattempt"), before);
  });

  await t.step("integration without a stored webhook secret rejects everything (fail closed)", async () => {
    const C = await w.signUp("owner-c@example.test", "Org C");
    await w.addIntegration(C, "razorpay", { key_id: "rzp_test_C", key_secret: "s" });
    const sig = await signRazorpay("any-guess", raw); // well-formed signature; no secret is stored to match it
    const r = await call(h(), "webhook-razorpay", { rawBody: raw, query: { brand_id: C.brand_id }, headers: { "X-Razorpay-Signature": sig } });
    assertEquals(r.status, 401);
  });

  await w.close();
}});
