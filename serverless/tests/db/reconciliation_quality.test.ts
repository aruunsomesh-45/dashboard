// Phase 3: reconciliation engine, data quality engine, daily-fact timezone fix, data security.
// [SYNTHETIC records seeded directly + LOCAL DB (real migrations/RLS via PGlite)]
import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";
import { type Tenant, World } from "../helpers/world.ts";
import { pgUserClient } from "../helpers/pg_supabase.ts";

const opts = { sanitizeResources: false, sanitizeOps: false };
const T0 = "2026-11-20T10:00:00Z";

async function order(w: World, t: Tenant, pid: string, num: string, total: number, extra: Record<string, unknown> = {}): Promise<string> {
  const row: Record<string, unknown> = {
    workspace_id: t.workspace_id, brand_id: t.brand_id, provider: "shopify", provider_id: pid, order_number: num,
    currency: "INR", gross_amount: total, net_sales: total, payment_gateways: "{Razorpay}", source_created_at: T0, financial_status: "paid", ...extra,
  };
  const cols = Object.keys(row);
  const [r] = await w.rows<{ id: string }>(
    `insert into commerce_order (${cols.join(",")}) values (${cols.map((_, i) => `$${i + 1}`).join(",")}) returning id`, Object.values(row));
  return r.id;
}

async function payment(w: World, t: Tenant, pid: string, amount: number, extra: Record<string, unknown> = {}): Promise<string> {
  const row: Record<string, unknown> = {
    workspace_id: t.workspace_id, brand_id: t.brand_id, provider: "razorpay", provider_id: pid, amount_minor: amount,
    currency: "INR", status: "captured", method: "upi", source_created_at: T0, ...extra,
  };
  const cols = Object.keys(row);
  const [r] = await w.rows<{ id: string }>(
    `insert into commerce_paymentattempt (${cols.join(",")}) values (${cols.map((_, i) => `$${i + 1}`).join(",")}) returning id`, Object.values(row));
  return r.id;
}

async function insertRow(w: World, table: string, row: Record<string, unknown>): Promise<string> {
  const cols = Object.keys(row);
  const [r] = await w.rows<{ id: string }>(
    `insert into ${table} (${cols.join(",")}) values (${cols.map((_, i) => `$${i + 1}`).join(",")}) returning id`, Object.values(row));
  return r.id;
}

const recon = async (w: World, type: string, id: string) =>
  (await w.rows<any>("select status, match_method, confidence::float as confidence, matched_order_id, details from commerce_reconciliation where entity_type=$1 and entity_id=$2", [type, id]))[0];

Deno.test({ ...opts, name: "Reconciliation engine", fn: async (t) => {
  const w = await World.create();
  const A = await w.signUp("owner-a@example.test", "Org A");
  const B = await w.signUp("owner-b@example.test", "Org B");

  const O1 = await order(w, A, "9001", "1001", 118000);
  const O2 = await order(w, A, "9002", "1002", 50000, { utm_source: "google", utm_medium: "cpc" });
  const O3 = await order(w, A, "9003", "1003", 70000, { source_created_at: "2026-11-20T12:00:00Z" });
  const O5a = await order(w, A, "9005", "7777", 1000);
  const O5b = await order(w, A, "7777", "1005", 1000);
  const O6 = await order(w, A, "9006", "1006", 10000);
  const O7 = await order(w, A, "9007", "1007", 5000, { payment_gateways: "{\"Cash on Delivery (COD)\"}" });
  await order(w, B, "9001", "1001", 118000); // same ids in another brand must never be matched
  const O9 = await order(w, A, "9009", "1009", 25000, { gateway_payment_ref: "pay_9" }); // Magic Checkout note attribute

  const P1 = await payment(w, A, "pay_1", 118000, { merchant_order_ref: "9001" });
  const P2 = await payment(w, A, "pay_2", 20000, { merchant_order_ref: "#1002" });
  const P3 = await payment(w, A, "pay_3", 70000, { source_created_at: "2026-11-20T12:05:00Z" });
  const P4 = await payment(w, A, "pay_4", 12345);
  const P5 = await payment(w, A, "pay_5", 1000, { merchant_order_ref: "7777" });
  const P6a = await payment(w, A, "pay_6a", 10000, { merchant_order_ref: "9006" });
  await payment(w, A, "pay_6b", 10000, { merchant_order_ref: "9006" });
  const P8 = await payment(w, A, "pay_8", 118000, { merchant_order_ref: "9001", status: "failed" });
  const P9 = await payment(w, A, "pay_9", 25000); // no notes at all: only the order knows its payment id
  await payment(w, B, "pay_9b", 25000);

  const S1 = await insertRow(w, "commerce_shipment", { workspace_id: A.workspace_id, brand_id: A.brand_id, provider: "delhivery", provider_id: "AWB1", awb: "AWB1", order_ref: "#1001", canonical_status: "in_transit" });
  const S2 = await insertRow(w, "commerce_shipment", { workspace_id: A.workspace_id, brand_id: A.brand_id, provider: "delhivery", provider_id: "AWB2", awb: "AWB2", order_ref: "X-none", canonical_status: "in_transit" });
  const S3 = await insertRow(w, "commerce_shipment", { workspace_id: A.workspace_id, brand_id: A.brand_id, provider: "delhivery", provider_id: "AWB3", awb: "AWB3", order_ref: "", canonical_status: "in_transit" });

  const rf = (pid: string, extra: Record<string, unknown>) => insertRow(w, "commerce_refund", {
    workspace_id: A.workspace_id, brand_id: A.brand_id, provider: "razorpay", provider_id: pid, amount_minor: 1000, currency: "INR", status: "processed", ...extra });
  const R1 = await rf("rfnd_1", { payment_provider_id: "pay_1" });
  const R2 = await rf("rfnd_2", { payment_provider_id: "pay_unknown" });
  const R3 = await rf("801", { provider: "shopify", order_provider_id: "9002" });
  const R4 = await rf("rfnd_4", { payment_provider_id: "pay_2", amount_minor: 30000 });

  const prod = await insertRow(w, "commerce_product", { workspace_id: A.workspace_id, brand_id: A.brand_id, provider: "shopify", provider_id: "555", title: "Shirt" });
  const variant = await insertRow(w, "commerce_productvariant", { workspace_id: A.workspace_id, brand_id: A.brand_id, provider: "shopify", provider_id: "55501", product_id: prod, title: "M" });
  const L1 = await insertRow(w, "commerce_orderline", { order_id: O1, title: "Shirt", provider_variant_id: "55501" });
  const L2 = await insertRow(w, "commerce_orderline", { order_id: O1, title: "Gone", provider_variant_id: "99999" });
  await insertRow(w, "analytics_ga4_transaction", { workspace_id: A.workspace_id, brand_id: A.brand_id, property_id: "p1", transaction_id: "1001",
    report_date: "2026-11-20", session_source: "instagram", session_medium: "social", session_campaign: "launch", currency: "INR" });

  let summary: any;
  await t.step("runs and summarises", async () => {
    const r = await w.admin.rpc("reconcile_brand", { p_brand_id: A.brand_id });
    assertEquals(r.error, null, JSON.stringify(r.error));
    summary = r.data;
    assertEquals(summary.new_payment_links, 6, "pay_9 (order's payment id), pay_1, pay_2, pay_6a, pay_6b, pay_8");
    assertEquals(summary.new_shipment_links, 1);
  });

  await t.step("exact order id on the payment -> MATCHED 1.00; order number -> 0.95", async () => {
    const r1 = await recon(w, "payment", P1);
    assertEquals([r1.status, r1.match_method, r1.confidence, r1.matched_order_id], ["MATCHED", "notes_order_id", 1, O1]);
    const r2 = await recon(w, "payment", P2);
    assertEquals([r2.status, r2.match_method, r2.confidence, r2.matched_order_id], ["MATCHED", "notes_order_number", 0.95, O2]);
  });

  await t.step("order carries the gateway payment id -> MATCHED 1.00 even when the payment has no notes", async () => {
    const r = await recon(w, "payment", P9);
    assertEquals([r.status, r.match_method, r.confidence, r.matched_order_id], ["MATCHED", "order_payment_id", 1, O9]);
    assertEquals((await recon(w, "order_payment", O9)).status, "MATCHED");
  });

  await t.step("look-alike (same amount within 30 min, no identifier) -> NEEDS_REVIEW, NOT linked", async () => {
    const r = await recon(w, "payment", P3);
    assertEquals([r.status, r.match_method, r.matched_order_id], ["NEEDS_REVIEW", "amount_time_candidate", null]);
    assertEquals(r.details.candidates[0].order_id, O3);
    assertEquals(await w.count("commerce_orderpaymentlink", "payment_attempt_id=$1", [P3]), 0);
    assertEquals((await recon(w, "order_payment", O3)).status, "UNMATCHED");
  });

  await t.step("nothing to go on -> UNMATCHED; ambiguous reference -> NEEDS_REVIEW, not linked", async () => {
    assertEquals((await recon(w, "payment", P4)).status, "UNMATCHED");
    const r5 = await recon(w, "payment", P5);
    assertEquals([r5.status, r5.match_method], ["NEEDS_REVIEW", "ambiguous_order_ref"]);
    assertEquals(r5.details.candidates.map((c: any) => c.order_id).sort(), [O5a, O5b].sort());
    assertEquals(await w.count("commerce_orderpaymentlink", "payment_attempt_id=$1", [P5]), 0);
  });

  await t.step("order-level: full / partial / over-payment; failed attempts don't count; COD out of scope", async () => {
    const o1 = await recon(w, "order_payment", O1);
    assertEquals([o1.status, o1.details.captured_minor, o1.details.failed_attempts], ["MATCHED", 118000, 1]);
    assertEquals((await recon(w, "payment", P8)).status, "MATCHED", "failed attempt still traced to its order");
    const o2 = await recon(w, "order_payment", O2);
    assertEquals([o2.status, o2.details.captured_minor], ["PARTIALLY_MATCHED", 20000]);
    const o6 = await recon(w, "order_payment", O6);
    assertEquals([o6.status, o6.details.captured_minor], ["NEEDS_REVIEW", 20000]);
    assertMatch(o6.details.reason, /exceeds/);
    assertEquals((await recon(w, "payment", P6a)).status, "MATCHED");
    assertEquals(await recon(w, "order_payment", O7), undefined, "non-Razorpay order is not payment-reconciled");
  });

  await t.step("shipments by courier order reference", async () => {
    const s1 = await recon(w, "shipment", S1);
    assertEquals([s1.status, s1.matched_order_id], ["MATCHED", O1]);
    assertEquals((await recon(w, "shipment", S2)).status, "UNMATCHED");
    const s3 = await recon(w, "shipment", S3);
    assertEquals(s3.status, "UNMATCHED");
    assertMatch(s3.details.reason, /no order reference/);
  });

  await t.step("refunds: payment id exact, order via payment link; unknown payment unmatched; over-refund flagged", async () => {
    const r1 = await recon(w, "refund", R1);
    assertEquals([r1.status, r1.matched_order_id], ["MATCHED", O1]);
    assertEquals((await recon(w, "refund", R2)).status, "UNMATCHED");
    const r3 = await recon(w, "refund", R3);
    assertEquals([r3.status, r3.matched_order_id], ["MATCHED", O2]);
    assertEquals((await recon(w, "refund", R4)).status, "NEEDS_REVIEW");
  });

  await t.step("order lines -> variants by platform variant id; unknown stays unlinked", async () => {
    const [l1] = await w.rows<any>("select variant_id from commerce_orderline where id=$1", [L1]);
    const [l2] = await w.rows<any>("select variant_id from commerce_orderline where id=$1", [L2]);
    assertEquals([l1.variant_id, l2.variant_id], [variant, null]);
  });

  await t.step("attribution: GA4 transaction -> MATCHED; UTM only -> PARTIALLY_MATCHED; neither -> UNMATCHED", async () => {
    const a1 = await recon(w, "order_attribution", O1);
    assertEquals([a1.status, a1.details.ga4.source], ["MATCHED", "instagram"]);
    assertEquals((await recon(w, "order_attribution", O2)).status, "PARTIALLY_MATCHED");
    assertEquals((await recon(w, "order_attribution", O3)).status, "UNMATCHED");
  });

  await t.step("brand isolation: nothing linked across brands", async () => {
    const [x] = await w.rows<any>(`select count(*)::int n from commerce_orderpaymentlink l join commerce_order o on o.id=l.order_id
                                     join commerce_paymentattempt p on p.id=l.payment_attempt_id where o.brand_id <> p.brand_id`);
    assertEquals(x.n, 0);
    assertEquals(await w.count("commerce_reconciliation", "brand_id=$1", [B.brand_id]), 0);
  });

  await t.step("idempotent: a second run adds no links and rewrites nothing unchanged", async () => {
    const before = await w.rows<any>("select entity_id, updated_at from commerce_reconciliation order by entity_id");
    const links = await w.count("commerce_orderpaymentlink");
    const r = await w.admin.rpc("reconcile_brand", { p_brand_id: A.brand_id });
    assertEquals([r.data.new_payment_links, r.data.new_shipment_links], [0, 0]);
    assertEquals(await w.count("commerce_orderpaymentlink"), links);
    const after = await w.rows<any>("select entity_id, updated_at from commerce_reconciliation order by entity_id");
    assertEquals(after.map((x) => String(x.updated_at)), before.map((x) => String(x.updated_at)), "unchanged rows not rewritten");
  });

  await w.close();
}});

Deno.test({ ...opts, name: "Data quality engine", fn: async (t) => {
  const w = await World.create();
  const A = await w.signUp("owner-a@example.test", "Org A");
  const B = await w.signUp("owner-b@example.test", "Org B");

  const good = await order(w, A, "1", "1", 118000, { subtotal_amount: 100000, shipping_amount: 5000, tax_amount: 13000, taxes_included: false, net_sales: 100000 });
  const badCurrency = await order(w, A, "2", "2", 1000, { currency: "RS" });
  const negNet = await order(w, A, "3", "3", 1000, { net_sales: -500 });
  const overRefund = await order(w, A, "4", "4", 1000, { refunded_amount: 2000 });
  const future = await order(w, A, "5", "5", 1000, { source_created_at: "2099-01-01T00:00:00Z" });
  const cancelledPaid = await order(w, A, "6", "6", 1000, { cancelled_at: T0, refunded_amount: 0 });
  const badTotal = await order(w, A, "7", "7", 120000, { subtotal_amount: 100000, shipping_amount: 5000, tax_amount: 13000, taxes_included: false });
  const missingNum = await order(w, A, "8", "", 1000);
  const custB = await insertRow(w, "commerce_customer", { workspace_id: B.workspace_id, brand_id: B.brand_id, provider: "shopify", provider_id: "c1", email: "b@x.test" });
  const crossRef = await order(w, A, "9", "9", 1000, { customer_id: custB });
  const c1 = await insertRow(w, "commerce_customer", { workspace_id: A.workspace_id, brand_id: A.brand_id, provider: "shopify", provider_id: "c2", email: "same@x.test" });
  const c2 = await insertRow(w, "commerce_customer", { workspace_id: A.workspace_id, brand_id: A.brand_id, provider: "shopify", provider_id: "c3", email: "same@x.test" });
  const weird = await payment(w, A, "pay_w", 1000, { source_status: "on_hold" });
  const overRefundPay = await payment(w, A, "pay_r", 1000, { refunded_amount_minor: 5000 });
  const fact = await insertRow(w, "analytics_factshopdaily", { workspace_id: A.workspace_id, brand_id: A.brand_id, fact_date: "2026-11-20", orders_count: 99, net_sales: 1 });
  const counts = async () => ({ o: await w.count("commerce_order"), p: await w.count("commerce_paymentattempt"), c: await w.count("commerce_customer") });
  const before = await counts();

  const issue = async (key: string, id: string) =>
    (await w.rows<any>("select severity, resolved_at, details from data_quality_issue where check_key=$1 and entity_id=$2", [key, id]))[0];

  await t.step("detects every seeded problem, with severity and details", async () => {
    const r = await w.admin.rpc("run_data_quality_checks", { p_brand_id: A.brand_id });
    assertEquals(r.error, null, JSON.stringify(r.error));
    const expected: Array<[string, string, string]> = [
      ["order_invalid_currency", badCurrency, "error"],
      ["order_negative_net_sales", negNet, "error"],
      ["order_refund_exceeds_total", overRefund, "error"],
      ["order_timestamp_out_of_range", future, "error"],
      ["order_cancelled_but_paid", cancelledPaid, "warning"],
      ["order_total_inconsistent", badTotal, "warning"],
      ["order_missing_number", missingNum, "error"],
      ["cross_brand_customer_reference", crossRef, "error"],
      ["customer_shared_email", c1, "info"],
      ["customer_shared_email", c2, "info"],
      ["payment_unknown_source_status", weird, "warning"],
      ["payment_refund_exceeds_amount", overRefundPay, "error"],
      ["fact_shop_daily_mismatch", fact, "error"],
    ];
    for (const [key, id, sev] of expected) {
      const i = await issue(key, id);
      assert(i, `missing issue ${key}`);
      assertEquals(i.severity, sev, key);
    }
    const [g] = await w.rows<any>("select count(*)::int n from data_quality_issue where entity_id=$1", [good]);
    assertEquals(g.n, 0, "a consistent order raises nothing");
    assertEquals(await w.count("data_quality_issue", "brand_id=$1", [B.brand_id]), 0, "per-brand");
  });

  await t.step("never deletes or edits the offending data", async () => {
    assertEquals(await counts(), before);
    const [o] = await w.rows<any>("select currency from commerce_order where id=$1", [badCurrency]);
    assertEquals(o.currency, "RS");
  });

  await t.step("fixed record -> issue resolved (kept as history); re-run is stable", async () => {
    await w.rows("update commerce_order set currency='INR' where id=$1", [badCurrency]);
    await w.admin.rpc("run_data_quality_checks", { p_brand_id: A.brand_id });
    assert((await issue("order_invalid_currency", badCurrency)).resolved_at, "resolved");
    const open1 = await w.count("data_quality_issue", "resolved_at is null");
    await w.admin.rpc("run_data_quality_checks", { p_brand_id: A.brand_id });
    assertEquals(await w.count("data_quality_issue", "resolved_at is null"), open1);
    await w.rows("update commerce_order set currency='RS' where id=$1", [badCurrency]);
    await w.admin.rpc("run_data_quality_checks", { p_brand_id: A.brand_id });
    assertEquals((await issue("order_invalid_currency", badCurrency)).resolved_at, null, "regression re-opens the same issue");
  });

  await w.close();
}});

Deno.test({ ...opts, name: "Daily facts use the brand's local date (bug fix)", fn: async () => {
  const w = await World.create();
  const A = await w.signUp("owner-a@example.test", "Org A");
  // 20:00 UTC = 01:30 IST next day; 04:00 UTC = 09:30 IST same day
  await order(w, A, "1", "1", 1000, { source_created_at: "2026-11-23T20:00:00Z" });
  await order(w, A, "2", "2", 1000, { source_created_at: "2026-11-24T04:00:00Z" });
  for (const d of ["2026-11-23", "2026-11-24"]) {
    const r = await w.admin.rpc("refresh_daily_fact_shop", { p_brand_id: A.brand_id, p_target_date: d });
    assertEquals(r.error, null, JSON.stringify(r.error));
  }
  const facts = await w.rows<any>("select fact_date::text d, orders_count from analytics_factshopdaily where brand_id=$1 order by 1", [A.brand_id]);
  assertEquals(facts.map((f) => [f.d, f.orders_count]), [["2026-11-23", 0], ["2026-11-24", 2]], "both orders were placed on 24 Nov IST");
  await w.admin.rpc("run_data_quality_checks", { p_brand_id: A.brand_id });
  assertEquals(await w.count("data_quality_issue", "check_key='fact_shop_daily_mismatch'"), 0, "facts agree with a recomputation");
  await w.close();
}});

Deno.test({ ...opts, name: "Phase 3 data security", fn: async (t) => {
  const w = await World.create();
  const A = await w.signUp("owner-a@example.test", "Org A");
  const B = await w.signUp("owner-b@example.test", "Org B");
  const oA = await order(w, A, "1", "1", 1000);
  await insertRow(w, "commerce_refund", { workspace_id: A.workspace_id, brand_id: A.brand_id, provider: "shopify", provider_id: "r1", order_id: oA, amount_minor: 10, currency: "INR", status: "processed" });
  await payment(w, A, "pay_1", 1000);
  await w.admin.rpc("reconcile_brand", { p_brand_id: A.brand_id });
  await order(w, A, "2", "2", 1000, { currency: "RS" });
  await w.admin.rpc("run_data_quality_checks", { p_brand_id: A.brand_id });
  await w.admin.rpc("ingest_raw_payload", { p_workspace_id: A.workspace_id, p_brand_id: A.brand_id, p_provider: "shopify", p_topic: "order",
    p_entity_id: "1", p_payload: { id: 1 }, p_payload_hash: "a".repeat(64), p_source: "sync", p_pii_redacted: true });
  const as = (tn: Tenant) => pgUserClient(w.db, w.auth, new Request("http://x/", { headers: { Authorization: `Bearer ${tn.token}` } }));
  const tables = ["commerce_refund", "commerce_reconciliation", "data_quality_issue", "commerce_order_history", "integrations_rawpayload"];

  await t.step("owners read their own Phase 3 rows", async () => {
    for (const tbl of tables) {
      const { data, error } = await as(A).from(tbl).select("id");
      assertEquals(error, null, `${tbl}: ${JSON.stringify(error)}`);
      assert((data as any[]).length > 0, `A sees own ${tbl}`);
    }
  });

  await t.step("another workspace sees none of them", async () => {
    for (const tbl of tables) {
      const { data } = await as(B).from(tbl).select("id");
      assertEquals((data as any[] | null)?.length ?? 0, 0, `B must not see A's ${tbl}`);
    }
  });

  await t.step("users cannot write engine outputs or call the engines/ingestion directly", async () => {
    const ins = await as(A).from("commerce_refund").insert({ workspace_id: A.workspace_id, brand_id: A.brand_id, provider: "x", provider_id: "y", amount_minor: 1, currency: "INR", status: "processed" });
    assert(ins.error, "insert into commerce_refund must be refused");
    const upd = await as(A).from("data_quality_issue").update({ resolved_at: new Date().toISOString() }).eq("brand_id", A.brand_id);
    const [open] = await w.rows<any>("select count(*)::int n from data_quality_issue where resolved_at is null");
    assert(upd.error || open.n > 0, "users cannot silence data quality issues");
    for (const fn of ["reconcile_brand", "run_data_quality_checks"]) {
      const r = await as(A).rpc(fn, { p_brand_id: A.brand_id });
      assert(r.error, `${fn} must not be callable by users`);
    }
    const ing = await as(A).rpc("ingest_raw_payload", { p_workspace_id: A.workspace_id, p_brand_id: A.brand_id, p_provider: "shopify", p_topic: "order",
      p_entity_id: "2", p_payload: { id: 2 }, p_payload_hash: "b".repeat(64), p_source: "sync", p_pii_redacted: true });
    assert(ing.error, "ingest_raw_payload is service-role only");
    const dedupe = await as(A).from("integrations_rawpayload_dedupe").select("brand_id");
    assert(dedupe.error || (dedupe.data as any[]).length === 0, "dedupe table not readable");
  });

  await t.step("a user can only refresh daily facts for brands they administer (guard, not just grants)", async () => {
    // Hosted Supabase grants EXECUTE on public functions to `authenticated` by default: simulate that,
    // so this proves the in-function guard rather than a missing grant.
    await w.db.exec("grant execute on function public.refresh_daily_fact_shop(uuid, date) to authenticated");
    const denied = await as(B).rpc("refresh_daily_fact_shop", { p_brand_id: A.brand_id, p_target_date: "2026-11-20" });
    assert(denied.error, "B must not refresh A's facts");
    assertMatch(denied.error.message, /not allowed/);
    const own = await as(A).rpc("refresh_daily_fact_shop", { p_brand_id: A.brand_id, p_target_date: "2026-11-20" });
    assertEquals(own.error, null, JSON.stringify(own.error));
  });

  await t.step("ingest_raw_payload refuses a brand/workspace mismatch", async () => {
    const r = await w.admin.rpc("ingest_raw_payload", { p_workspace_id: B.workspace_id, p_brand_id: A.brand_id, p_provider: "shopify", p_topic: "order",
      p_entity_id: "3", p_payload: { id: 3 }, p_payload_hash: "c".repeat(64), p_source: "sync", p_pii_redacted: true });
    assert(r.error);
  });

  await w.close();
}});
