// Phase 3 ingestion: raw layer, dedupe, PII minimisation, order history, refunds, incremental
// checkpoints, failure tracking + safe re-processing, overlap protection.
// [MOCKED upstream APIs (synthetic payloads) + LOCAL DB (real migrations/RLS via PGlite)]
import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";
import { call, json, type Tenant, World } from "../helpers/world.ts";
import { razorpayPayment, razorpayWebhook, shopifyOrder } from "../helpers/payloads.ts";
import { signRazorpay, signShopify } from "../../supabase/functions/_shared/signatures.ts";
import { createHandler as shopifySync } from "../../supabase/functions/shopify-sync/handler.ts";
import { createHandler as razorpaySync } from "../../supabase/functions/razorpay-sync/handler.ts";
import { createHandler as reprocessRaw } from "../../supabase/functions/reprocess-raw/handler.ts";
import { createHandler as razorpayHook } from "../../supabase/functions/webhook-razorpay/handler.ts";
import { createHandler as shopifyHook } from "../../supabase/functions/webhook-shopify/handler.ts";

const opts = { sanitizeResources: false, sanitizeOps: false };
const body = (t: Tenant, extra: Record<string, unknown> = {}) => ({ workspace_id: t.workspace_id, brand_id: t.brand_id, ...extra });
const ORDERS = /test-store\.myshopify\.com\/admin\/api\/[^/]+\/orders\.json/;

Deno.test({ ...opts, name: "Shopify ingestion pipeline", fn: async (t) => {
  const w = await World.create();
  const A = await w.signUp("owner-a@example.test", "Org A");
  await w.addIntegration(A, "shopify", { shop_domain: "test-store.myshopify.com", access_token: "shpat_synthetic", api_secret: "shpss_hook" });
  const sync = (extra: Record<string, unknown> = {}) => call(shopifySync(w.deps()), "shopify-sync", { token: A.token, body: body(A, extra) });
  const o1 = shopifyOrder(1, { updated_at: "2026-11-10T11:00:00+05:30" });
  const o2 = shopifyOrder(2, {
    updated_at: "2026-11-10T12:00:00+05:30",
    payment_gateway_names: ["Razorpay"],
    landing_site: "/?utm_source=instagram&utm_medium=social&utm_campaign=launch",
    refunds: [{ id: 801, created_at: "2026-11-10T12:00:00+05:30", transactions: [{ kind: "refund", status: "success", amount: "180.00" }] }],
    financial_status: "partially_refunded",
  });

  await t.step("initial sync: raw stored (PII removed), order linked to raw, refunds + history recorded, checkpoint set", async () => {
    w.http.on(ORDERS, () => json({ orders: [o1, o2] }));
    const r = await sync();
    assertEquals(r.status, 200, JSON.stringify(r.body));
    assertEquals([r.body.data.mode, r.body.data.records_created], ["initial", 2]);
    assertMatch(w.http.calls[0].url, /order=updated_at%20asc&updated_at_min=/);

    const raws = await w.rows<any>("select id, processing_status, pii_redacted, source, payload::text as p, payload_hash from integrations_rawpayload order by entity_id");
    assertEquals(raws.length, 2);
    assert(raws.every((x) => x.processing_status === "processed" && x.pii_redacted && x.source === "sync" && /^[0-9a-f]{64}$/.test(x.payload_hash)));
    assert(!raws.some((x) => x.p.includes("@example.test")), "no customer email in raw payloads");
    assert(raws[0].p.includes('"total_price": "1180.00"') || raws[0].p.includes('"total_price":"1180.00"'), "business data kept");

    const [cust] = await w.rows<any>("select email from commerce_customer where provider_id='5001'");
    assertEquals(cust.email, "buyer1@example.test", "PII lives once, in commerce_customer");

    const [ord] = await w.rows<any>(`select o.raw_payload_ref, o.refunded_amount, o.subtotal_amount, o.payment_gateways, o.utm_source, o.source_financial_status
                                      from commerce_order o where provider_id='2'`);
    assert(raws.some((x) => x.id === ord.raw_payload_ref), "order points at its raw payload");
    assertEquals([Number(ord.refunded_amount), Number(ord.subtotal_amount), ord.utm_source, ord.source_financial_status], [18000, 100000, "instagram", "partially_refunded"]);
    assertEquals(ord.payment_gateways, ["Razorpay"]);
    const [rf] = await w.rows<any>("select amount_minor, status, order_id is not null as linked from commerce_refund where provider='shopify' and provider_id='801'");
    assertEquals([Number(rf.amount_minor), rf.status, rf.linked], [18000, "processed", true]);

    assertEquals(await w.count("commerce_order_history", "change_kind='created'"), 2);
    const [cur] = await w.rows<any>("select cursor_value from integrations_synccursor where resource='orders'");
    assertEquals(cur.cursor_value, "2026-11-10T06:30:00.000Z", "checkpoint = newest updated_at, UTC");
  });

  await t.step("unchanged re-fetch: incremental from checkpoint - overlap, no new raw row, no history row", async () => {
    w.http.calls = [];
    const r = await sync();
    assertEquals(r.body.data.mode, "incremental");
    assert(decodeURIComponent(w.http.calls[0].url).includes("updated_at_min=2026-11-10T06:20:00.000Z"), w.http.calls[0].url);
    assertEquals(await w.count("integrations_rawpayload"), 2, "identical payloads are not stored twice");
    assertEquals(await w.count("commerce_order_history"), 2);
    assertEquals(await w.count("commerce_order"), 2);
  });

  await t.step("changed order: new raw version + 'updated' history row with the new status", async () => {
    w.http.routes = [];
    const changed = { ...o1, financial_status: "refunded", updated_at: "2026-11-10T13:00:00+05:30",
      refunds: [{ id: 802, transactions: [{ kind: "refund", status: "success", amount: "1180.00" }] }] };
    w.http.on(ORDERS, () => json({ orders: [changed] }));
    await sync();
    assertEquals(await w.count("integrations_rawpayload"), 3);
    const hist = await w.rows<any>(`select h.change_kind, h.financial_status, h.refunded_amount from commerce_order_history h
                                      join commerce_order o on o.id = h.order_id where o.provider_id='1' order by h.recorded_at`);
    assertEquals(hist.map((h) => [h.change_kind, h.financial_status]), [["created", "paid"], ["updated", "refunded"]]);
    assertEquals(Number(hist[1].refunded_amount), 118000);
  });

  await t.step("failure: kept as failed raw row, checkpoint stops before it, reported by data quality", async () => {
    await w.db.exec(`create function test_boom() returns trigger language plpgsql as $$
                       begin if new.provider_id = '666' then raise exception 'boom: simulated write failure'; end if; return new; end $$;
                     create trigger test_boom before insert or update on commerce_order for each row execute function test_boom();`);
    w.http.routes = [];
    const a = shopifyOrder(10, { updated_at: "2026-11-11T10:00:00+05:30" });
    const bad = shopifyOrder(666, { updated_at: "2026-11-11T11:00:00+05:30" });
    const c = shopifyOrder(11, { updated_at: "2026-11-11T12:00:00+05:30" });
    w.http.on(ORDERS, () => json({ orders: [a, bad, c] }));
    const r = await sync();
    assertEquals([r.status, r.body.data.status, r.body.data.records_failed], [200, "partial", 1]);
    const [cur] = await w.rows<any>("select cursor_value from integrations_synccursor where resource='orders'");
    assertEquals(cur.cursor_value, "2026-11-11T04:30:00.000Z", "advances only through the unbroken prefix (order 10)");
    const [failed] = await w.rows<any>("select processing_status, error, attempts from integrations_rawpayload where entity_id='666'");
    assertEquals([failed.processing_status, failed.attempts], ["failed", 1]);
    assertMatch(failed.error, /boom/);
    assertEquals(await w.count("commerce_order", "provider_id='11'"), 1, "later orders still saved");

    const dq = await w.admin.rpc("run_data_quality_checks", { p_brand_id: A.brand_id });
    assertEquals(dq.error, null);
    assertEquals(await w.count("data_quality_issue", "check_key='raw_payload_processing_failed' and resolved_at is null"), 1);
  });

  await t.step("reprocess-raw: fixed cause -> processed from the stored payload, customer details not blanked", async () => {
    await w.db.exec("drop trigger test_boom on commerce_order");
    const r = await call(reprocessRaw(w.deps()), "reprocess-raw", { token: A.token, body: body(A) });
    assertEquals(r.status, 200, JSON.stringify(r.body));
    assertEquals([r.body.data.selected, r.body.data.reprocessed, r.body.data.still_failed], [1, 1, 0]);
    const [raw] = await w.rows<any>("select processing_status, attempts, replayed_at is not null as replayed from integrations_rawpayload where entity_id='666'");
    assertEquals([raw.processing_status, raw.attempts, raw.replayed], ["processed", 2, true]);
    const [o] = await w.rows<any>(`select o.customer_id is not null as has_customer, c.email from commerce_order o
                                    left join commerce_customer c on c.id = o.customer_id where o.provider_id='666'`);
    assertEquals([o.has_customer, o.email], [true, "buyer666@example.test"], "customer row reused, never overwritten with redacted values");
    assertEquals(await w.count("data_quality_issue", "check_key='raw_payload_processing_failed' and resolved_at is null"), 0, "issue auto-resolved");
    assertEquals(await w.count("data_quality_issue", "check_key='raw_payload_processing_failed' and resolved_at is not null"), 1, "history kept");
  });

  await t.step("reprocess-raw: viewers may not run it", async () => {
    const V = await w.signUp("viewer@example.test", "Org V");
    await w.addMember(A.workspace_id, V.user.id, "viewer");
    const r = await call(reprocessRaw(w.deps()), "reprocess-raw", { token: V.token, body: body(A) });
    assertEquals(r.status, 403);
  });

  await t.step("explicit backfill never rewinds the checkpoint", async () => {
    w.http.routes = [];
    w.http.on(ORDERS, () => json({ orders: [shopifyOrder(12, { updated_at: "2025-01-01T00:00:00Z", created_at: "2025-01-01T00:00:00Z" })] }));
    const r = await sync({ days: 365 });
    assertEquals(r.body.data.mode, "backfill");
    const [cur] = await w.rows<any>("select cursor_value from integrations_synccursor where resource='orders'");
    assertEquals(cur.cursor_value, "2026-11-11T04:30:00.000Z");
    const [raw] = await w.rows<any>("select source from integrations_rawpayload where entity_id='12'");
    assertEquals(raw.source, "backfill");
  });

  await t.step("overlapping syncs for one brand: one runs, the other gets 409", async () => {
    w.http.routes = [];
    w.http.on(ORDERS, async () => {
      await new Promise((res) => setTimeout(res, 50));
      return json({ orders: [] });
    });
    const [r1, r2] = await Promise.all([sync(), sync()]);
    assertEquals([r1.status, r2.status].sort(), [200, 409]);
    assertEquals(await w.count("integrations_syncrun", "status='running'"), 0);
  });

  await t.step("Shopify refunds/create webhook -> refund linked to its order", async () => {
    const refund = { id: 803, order_id: 2, transactions: [{ kind: "refund", status: "success", amount: "50.00" }] };
    const raw = JSON.stringify(refund);
    const r = await call(shopifyHook(w.deps()), "webhook-shopify", {
      rawBody: raw, query: { brand_id: A.brand_id },
      headers: { "X-Shopify-Topic": "refunds/create", "X-Shopify-Hmac-Sha256": await signShopify("shpss_hook", raw), "X-Shopify-Event-Id": "evt-refund-803" },
    });
    assertEquals(r.status, 200, JSON.stringify(r.body));
    const [rf] = await w.rows<any>(`select r.amount_minor, o.provider_id from commerce_refund r join commerce_order o on o.id = r.order_id where r.provider_id='803'`);
    assertEquals([Number(rf.amount_minor), rf.provider_id], [5000, "2"]);
  });

  await w.close();
}});

Deno.test({ ...opts, name: "Razorpay ingestion pipeline", fn: async (t) => {
  const w = await World.create();
  const A = await w.signUp("owner-a@example.test", "Org A");
  await w.addIntegration(A, "razorpay", { key_id: "rzp_test_SYNTH", key_secret: "synthetic_secret", webhook_secret: "rzp_whsec" });
  const send = async (event: Record<string, unknown>, eventId: string) => {
    const raw = JSON.stringify(event);
    return call(razorpayHook(w.deps()), "webhook-razorpay", {
      rawBody: raw, query: { brand_id: A.brand_id },
      headers: { "x-razorpay-signature": await signRazorpay("rzp_whsec", raw), "x-razorpay-event-id": eventId },
    });
  };

  await t.step("payment webhook: original status, order reference from notes, PII-free raw payload", async () => {
    const r = await send(razorpayWebhook("payment.captured", razorpayPayment("pay_R1", { email: "payer@example.test", contact: "+919000000000", notes: { shopify_order_id: "9001", address: "Flat 1" } })), "evt-1");
    assertEquals(r.status, 200, JSON.stringify(r.body));
    const [p] = await w.rows<any>("select status, source_status, merchant_order_ref, merchant_order_ref_key from commerce_paymentattempt where provider_id='pay_R1'");
    assertEquals([p.status, p.source_status, p.merchant_order_ref, p.merchant_order_ref_key], ["captured", "captured", "9001", "shopify_order_id"]);
    const [raw] = await w.rows<any>("select payload::text as p, source from integrations_rawpayload where entity_id='pay_R1'");
    assertEquals(raw.source, "webhook");
    for (const s of ["payer@example.test", "+919000000000", "Flat 1"]) assert(!raw.p.includes(s), `raw leaked ${s}`);
  });

  await t.step("refund webhook: refund row + payment refund fields; resend is a duplicate", async () => {
    const event = {
      entity: "event", event: "refund.processed", contains: ["refund", "payment"],
      payload: {
        refund: { entity: { id: "rfnd_R1", entity: "refund", payment_id: "pay_R1", amount: 5000, currency: "INR", status: "processed", created_at: 1763712100 } },
        payment: { entity: razorpayPayment("pay_R1", { amount_refunded: 5000, refund_status: "partial" }) },
      },
    };
    const r1 = await send(event, "evt-rf-1");
    assertEquals(r1.status, 200, JSON.stringify(r1.body));
    const [rf] = await w.rows<any>("select amount_minor, status, payment_provider_id from commerce_refund where provider_id='rfnd_R1'");
    assertEquals([Number(rf.amount_minor), rf.status, rf.payment_provider_id], [5000, "processed", "pay_R1"]);
    const [p] = await w.rows<any>("select refunded_amount_minor, refund_status from commerce_paymentattempt where provider_id='pay_R1'");
    assertEquals([Number(p.refunded_amount_minor), p.refund_status], [5000, "partial"]);
    const r2 = await send(event, "evt-rf-1");
    assertEquals(r2.body.data.status, "duplicate");
    assertEquals(await w.count("commerce_refund"), 1);
  });

  await t.step("payment sync: checkpoint only after a complete, failure-free pass", async () => {
    w.http.on(/api\.razorpay\.com\/v1\/payments/, () => json({ items: [razorpayPayment("pay_S1"), razorpayPayment("pay_S2")] }));
    const r1 = await call(razorpaySync(w.deps()), "razorpay-sync", { token: A.token, body: body(A) });
    assertEquals([r1.status, r1.body.data.mode], [200, "initial"]);
    assert(r1.body.data.cursor, "cursor saved after a complete pass");
    w.http.calls = [];
    const r2 = await call(razorpaySync(w.deps()), "razorpay-sync", { token: A.token, body: body(A) });
    assertEquals(r2.body.data.mode, "incremental");
    const from = Number(new URL(w.http.calls[0].url).searchParams.get("from"));
    assertEquals(from, Math.floor((Date.parse(r1.body.data.cursor) - 10 * 60_000) / 1000));
    // pay_R1 has two versions (captured, then refunded: a changed payload is a new version);
    // pay_S1/pay_S2 were fetched twice but stored once each.
    assertEquals(await w.count("integrations_rawpayload", "provider='razorpay' and topic='payment' and entity_id='pay_R1'"), 2);
    assertEquals(await w.count("integrations_rawpayload", "provider='razorpay' and topic='payment' and entity_id in ('pay_S1','pay_S2')"), 2);
  });

  await w.close();
}});
