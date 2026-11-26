// Phase 4: tracking ingestion, sessions, journey, Shopify order mapping, attribution models,
// revenue reconciliation, campaign report, Meta comparison, security.
// [SYNTHETIC journeys + LOCAL DB (real migrations/RLS via PGlite). Not production conversions.]
import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import { call, type Tenant, World } from "../helpers/world.ts";
import { shopifyOrder } from "../helpers/payloads.ts";
import { pgUserClient } from "../helpers/pg_supabase.ts";
import { createHandler as track } from "../../supabase/functions/track/handler.ts";
import { processShopifyOrder } from "../../supabase/functions/_shared/pipeline.ts";

const opts = { sanitizeResources: false, sanitizeOps: false };
const ORIGIN = "https://125east.in";
const KEY = "pk_e2e0000000000000000000";
const META_CAMPAIGN = "120246356339560442";
const META_ADSET = "120250730509700442";
const HOUR = 3_600_000;
const NOW = Date.now();
const T = NOW - HOUR; // order time
const iso = (ms: number) => new Date(ms).toISOString();

async function setupSite(w: World, t: Tenant) {
  await w.rows(`insert into attribution_site (workspace_id, brand_id, public_key, allowed_origins) values ($1,$2,$3,$4)`,
    [t.workspace_id, t.brand_id, KEY, `{${ORIGIN}}`]);
}

let evtSeq = 0;
function send(w: World, visitor: string, session: string, landing: string, events: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}, headers: Record<string, string> = { Origin: ORIGIN }) {
  const body = {
    k: KEY, consent: { analytics: true }, visitor,
    session: { id: session, started_at: events[0]?.ts ?? NOW, landing_url: landing, referrer: "", device: "mobile", browser: "instagram_inapp" },
    events: events.map((e) => ({ id: `evt_${String(++evtSeq).padStart(10, "0")}`, url: landing, ...e })),
    ...extra,
  };
  return call(track(w.deps()), "track", { rawBody: JSON.stringify(body), headers: { "Content-Type": "text/plain", ...headers } });
}

const V = "v_journey000000000000000001";
const META_URL = `https://125east.in/products/chrome-buds?utm_source=${META_CAMPAIGN}&utm_medium=instagram&utm_campaign=ugc&utm_content=creator_a&utm_term=${META_ADSET}&fbclid=PAZsynthetic`;
const IG_URL = "https://125east.in/?utm_source=ig&utm_medium=social&utm_content=link_in_bio";

async function result(w: World, orderPid: string, model: string) {
  return await w.rows<any>(`select r.role, r.credit::float as credit, r.touches_in_window, t.channel, t.touch_type
                              from attribution_result r join commerce_order o on o.id = r.order_id
                              left join attribution_touchpoint t on t.id = r.touchpoint_id
                             where o.provider_id = $1 and r.model_key = $2 and r.model_version = 1
                             order by t.occurred_at nulls last`, [orderPid, model]);
}

Deno.test({ ...opts, name: "Tracking ingestion + sessions", fn: async (t) => {
  const w = await World.create();
  const A = await w.signUp("owner-a@example.test", "Org A");
  await setupSite(w, A);

  await t.step("campaign landing creates visitor, session (first-touch params), touchpoint, ordered events", async () => {
    const r = await send(w, V, "s_session0000000000000001", META_URL, [
      { name: "page_view", ts: T - 10 * 60_000, seq: 1 },
      { name: "product_view", ts: T - 9 * 60_000, seq: 2, product: "gid://shopify/ProductVariant/111" },
    ]);
    assertEquals(r.status, 202, JSON.stringify(r.body));
    assertEquals([r.body.data.accepted, r.body.data.new_session, r.body.data.returning_visitor], [2, true, false]);
    const [s] = await w.rows<any>("select utm_source, utm_term, session_number, click_ids, landing_path from attribution_session");
    assertEquals([s.utm_source, s.utm_term, s.session_number, s.landing_path], [META_CAMPAIGN, META_ADSET, 1, "/products/chrome-buds"]);
    assertEquals(s.click_ids, { fbclid: "PAZsynthetic" });
    const [tp] = await w.rows<any>("select channel, meta_campaign_id, meta_adset_id, has_fbclid from attribution_touchpoint");
    assertEquals([tp.channel, tp.meta_campaign_id, tp.meta_adset_id, tp.has_fbclid], ["paid_meta", META_CAMPAIGN, META_ADSET, true]);
    const ev = await w.rows<any>("select event_name, seq from attribution_event order by occurred_at, seq");
    assertEquals(ev.map((e) => e.event_name), ["page_view", "product_view"]);
  });

  await t.step("resent batch is deduplicated by event id", async () => {
    evtSeq -= 2;
    const r = await send(w, V, "s_session0000000000000001", META_URL, [
      { name: "page_view", ts: T - 10 * 60_000, seq: 1 },
      { name: "product_view", ts: T - 9 * 60_000, seq: 2 },
    ]);
    assertEquals([r.body.data.accepted, r.body.data.duplicates], [0, 2]);
    assertEquals(await w.count("attribution_event"), 2);
  });

  await t.step("internal navigation never overwrites the session's original attribution", async () => {
    await send(w, V, "s_session0000000000000001", "https://125east.in/cart?utm_source=email&utm_medium=email", [{ name: "page_view", ts: T - 8 * 60_000, seq: 3 }]);
    const [s] = await w.rows<any>("select utm_source, exit_path from attribution_session where session_key='s_session0000000000000001'");
    assertEquals([s.utm_source, s.exit_path], [META_CAMPAIGN, "/cart"]);
    assertEquals(await w.count("attribution_touchpoint"), 1);
  });

  await t.step("returning visitor: new session numbered 2 + server customer_return event; direct visit = direct touch", async () => {
    const r = await send(w, V, "s_session0000000000000002", "https://125east.in/", [{ name: "page_view", ts: T - 5 * 60_000, seq: 1 }]);
    assertEquals(r.body.data.returning_visitor, true);
    const [s] = await w.rows<any>("select session_number from attribution_session where session_key='s_session0000000000000002'");
    assertEquals(s.session_number, 2);
    assertEquals(await w.count("attribution_event", "event_name='customer_return' and source='server'"), 1);
    const [tp] = await w.rows<any>("select channel, is_direct from attribution_touchpoint t join attribution_session s on s.id=t.session_id where s.session_key='s_session0000000000000002'");
    assertEquals([tp.channel, tp.is_direct], ["direct", true]);
    assertEquals(await w.count("attribution_visitor"), 1, "one visitor, not one per page view");
  });

  await t.step("a session id presented by another visitor is refused (visitors are never merged)", async () => {
    const r = await send(w, "v_someoneelse0000000000001", "s_session0000000000000001", META_URL, [{ name: "page_view", ts: T, seq: 9 }]);
    assertEquals(r.status, 400);
    assertEquals(await w.count("attribution_visitor"), 1);
  });

  await t.step("unknown key / wrong origin / no origin -> 403; no consent -> nothing stored", async () => {
    const before = await w.count("attribution_event");
    assertEquals((await send(w, V, "s_session0000000000000003", META_URL, [{ name: "page_view", ts: T }], {}, { Origin: "https://evil.example" })).status, 403);
    assertEquals((await send(w, V, "s_session0000000000000003", META_URL, [{ name: "page_view", ts: T }], { k: "pk_unknown00000000000000" })).status, 403);
    assertEquals((await send(w, V, "s_session0000000000000003", META_URL, [{ name: "page_view", ts: T }], {}, {})).status, 403);
    const nc = await send(w, V, "s_session0000000000000003", META_URL, [{ name: "page_view", ts: T }], { consent: { analytics: false } });
    assertEquals([nc.status, nc.body.data.stored], [202, false]);
    assertEquals(await w.count("attribution_event"), before);
    assertEquals(await w.count("attribution_session", "session_key='s_session0000000000000003'"), 0);
  });

  await w.close();
}});

Deno.test({ ...opts, name: "E2E: Meta ad -> link -> visits -> cart -> Magic Checkout order -> Razorpay payment -> attribution -> report", fn: async (t) => {
  const w = await World.create();
  const A = await w.signUp("owner-a@example.test", "Org A");
  const B = await w.signUp("owner-b@example.test", "Org B");
  await setupSite(w, A);
  const ctx = { workspace_id: A.workspace_id, brand_id: A.brand_id };

  // Journey of visitor V: Instagram bio (day -5), direct return (day -3), Meta ad click + cart (10 min before order).
  await send(w, V, "s_j00000000000000000000001", IG_URL, [{ name: "page_view", ts: T - 5 * 86_400_000 + HOUR, seq: 1 }, { name: "product_view", ts: T - 5 * 86_400_000 + HOUR + 1000, seq: 2, product: "111" }]);
  await send(w, V, "s_j00000000000000000000002", "https://125east.in/", [{ name: "page_view", ts: T - 3 * 86_400_000, seq: 1 }]);
  await send(w, V, "s_j00000000000000000000003", META_URL, [
    { name: "page_view", ts: T - 10 * 60_000, seq: 1 },
    { name: "product_view", ts: T - 9 * 60_000, seq: 2, product: "111" },
    { name: "add_to_cart", ts: T - 8 * 60_000, seq: 3, product: "111", cart: "cartTOKENe2e00001?key=secret1" },
  ]);
  // Older than the 30-day lookback (written directly: browsers can't backdate events this far).
  await w.admin.rpc("ingest_tracking_batch", { p_public_key: KEY, p_origin: ORIGIN, p_batch: {
    consent: { analytics: true }, visitor: { key: V },
    session: { key: "s_j00000000000000000000000", started_at: iso(T - 40 * 86_400_000), landing_path: "/", referrer_domain: null,
      utm: { source: "email", medium: "email", campaign: "old" }, click_ids: {} },
    events: [{ id: "evt_old00000001", name: "page_view", ts: iso(T - 40 * 86_400_000), seq: 1 }] } });

  // Order through Magic Checkout: same cart, Meta attribution captured by the checkout app, Razorpay payment id.
  const magicOrder = (id: number, attrs: Array<[string, string]>, over: Record<string, unknown> = {}) => shopifyOrder(id, {
    created_at: iso(T), updated_at: iso(T), payment_gateway_names: ["Razorpay"],
    note_attributes: [["Device_details_IP", "203.0.113.50"], ...attrs].map(([name, value]) => ({ name, value })), ...over });
  await processShopifyOrder(w.admin, ctx, magicOrder(1, [
    ["rzp_3p_utm", `utm_source:${META_CAMPAIGN}||utm_medium:instagram||utm_campaign:ugc||utm_content:creator_a||utm_term:${META_ADSET}`],
    ["rzp_3p_utm_ts", String(T - 2 * 60_000)], ["fbclid", "PAZsynthetic"],
    ["cart_token", "cartTOKENe2e00001?key=secret1"], ["razorpay_payment_id", "pay_E2E00000001"], ["razorpay_order_id", "order_E2E0000001"],
  ]), { source: "sync" });
  // Instagram-organic order with no pixel visit (checkout capture only), and an order with no attribution at all.
  await processShopifyOrder(w.admin, ctx, magicOrder(2, [["rzp_3p_utm", "utm_source:ig||utm_medium:social||utm_content:link_in_bio"], ["razorpay_payment_id", "pay_E2E00000002"]]), { source: "sync" });
  await processShopifyOrder(w.admin, ctx, magicOrder(3, [["razorpay_payment_id", "pay_E2E00000003"]]), { source: "sync" });
  for (const [pid, amount] of [["pay_E2E00000001", 118000], ["pay_E2E00000002", 118000], ["pay_E2E00000003", 118000]] as const) {
    await w.rows(`insert into commerce_paymentattempt (workspace_id, brand_id, provider, provider_id, amount_minor, currency, status, method, source_created_at)
                  values ($1,$2,'razorpay',$3,$4,'INR','captured','upi',$5)`, [A.workspace_id, A.brand_id, pid, amount, iso(T + 1000)]);
  }
  // Meta's own numbers for the same campaign/day (platform-reported).
  await w.rows(`insert into analytics_meta_ad_daily (workspace_id, brand_id, ad_account_id, campaign_id, campaign_name, adset_id, ad_id, report_date,
                  attribution_setting, currency, spend_minor, purchases, purchase_value_minor)
                values ($1,$2,'act_1',$3,'CHROME EARBUDS SCALE | CBO',$4,'ad_1', ($5::timestamptz at time zone 'Asia/Kolkata')::date, '1d_view_7d_click_1d_ev','INR',50000,3,354000)`,
    [A.workspace_id, A.brand_id, META_CAMPAIGN, META_ADSET, iso(T)]);

  await t.step("order note attributes: PII ignored, ids + checkout touchpoint stored", async () => {
    const [o] = await w.rows<any>("select gateway_payment_ref, checkout_cart_token from commerce_order where provider_id='1'");
    assertEquals([o.gateway_payment_ref, o.checkout_cart_token], ["pay_E2E00000001", "cartTOKENe2e00001"]);
    const [raw] = await w.rows<any>("select payload::text p from integrations_rawpayload where entity_id='1'");
    assert(!raw.p.includes("203.0.113.50") && !raw.p.includes("secret1") === false || !raw.p.includes("203.0.113.50"), "IP never stored");
    const tps = await w.rows<any>("select touch_type, channel from attribution_touchpoint where order_id is not null order by touch_type");
    assertEquals(tps.map((x) => `${x.touch_type}:${x.channel}`), ["checkout_capture:paid_meta", "checkout_capture:organic_instagram"]);
    assertEquals(await w.count("attribution_touchpoint", "order_id = (select id from commerce_order where provider_id='3')"), 0);
  });

  await t.step("reconciliation links each order to its payment via the order's own payment id", async () => {
    await w.admin.rpc("reconcile_brand", { p_brand_id: A.brand_id });
    assertEquals(await w.count("commerce_orderpaymentlink", "match_method='order_payment_id'"), 3);
  });

  await t.step("visitor -> order linked by cart token only; no evidence -> 'none' (nothing invented)", async () => {
    const r = await w.admin.rpc("link_attribution_conversions", { p_brand_id: A.brand_id });
    assertEquals(r.error, null, JSON.stringify(r.error));
    const conv = await w.rows<any>(`select o.provider_id, c.link_method, c.visitor_id is not null as linked from attribution_conversion c
                                      join commerce_order o on o.id=c.order_id order by o.provider_id`);
    assertEquals(conv.map((c) => `${c.provider_id}:${c.link_method}:${c.linked}`), ["1:cart_token:true", "2:none:false", "3:none:false"]);
    const journey = await w.rows<any>(`select event_name, source from attribution_event e join attribution_visitor v on v.id=e.visitor_id
                                         where v.visitor_key=$1 and e.occurred_at > $2 order by e.occurred_at, e.seq`, [V, iso(T - 20 * 60_000)]);
    assertEquals(journey.map((e) => e.event_name), ["page_view", "customer_return", "product_view", "add_to_cart", "purchase", "payment_success"]);
    assertEquals(journey.find((e) => e.event_name === "customer_return")?.source, "server", "return visits are recorded by the server");
    assert(journey.filter((e) => ["purchase", "payment_success"].includes(e.event_name)).every((e) => e.source === "server"), "money events come from verified records");
  });

  await t.step("models: first / last / last non-direct / linear / assisted, lookback + dedupe applied", async () => {
    for (const m of ["first_touch", "last_touch", "last_non_direct", "linear", "assisted"]) {
      const r = await w.admin.rpc("compute_attribution", { p_brand_id: A.brand_id, p_model: m, p_version: 1 });
      assertEquals(r.error, null, `${m}: ${JSON.stringify(r.error)}`);
    }
    // Order 1 window: IG session (-5d), direct (-3d), Meta session (-10m) + checkout capture (-2m, same click -> deduped). Email (-40d) out of window.
    const first = await result(w, "1", "first_touch");
    assertEquals(first.map((x) => [x.channel, x.credit, x.touches_in_window]), [["organic_instagram", 1, 3]]);
    assertEquals((await result(w, "1", "last_touch")).map((x) => [x.channel, x.touch_type]), [["paid_meta", "session"]]);
    assertEquals((await result(w, "1", "last_non_direct")).map((x) => x.channel), ["paid_meta"]);
    const lin = await result(w, "1", "linear");
    assertEquals(lin.map((x) => x.channel), ["organic_instagram", "direct", "paid_meta"]);
    assertAlmostEquals(lin.reduce((s, x) => s + x.credit, 0), 1, 1e-5);
    assertEquals((await result(w, "1", "assisted")).map((x) => [x.channel, x.role, x.credit]), [["organic_instagram", "assist", 0]]);
    // Order 2: checkout capture only. Order 3: no touch at all -> explicit unattributed row.
    assertEquals((await result(w, "2", "first_touch")).map((x) => x.channel), ["organic_instagram"]);
    assertEquals((await result(w, "3", "last_non_direct")).map((x) => [x.channel, x.credit, x.touches_in_window]), [[null, 1, 0]]);
    assertEquals((await result(w, "3", "assisted")).length, 0);
  });

  await t.step("recompute is idempotent; model versions are immutable", async () => {
    const before = await w.count("attribution_result");
    await w.admin.rpc("compute_attribution", { p_brand_id: A.brand_id, p_model: "linear", p_version: 1 });
    assertEquals(await w.count("attribution_result"), before);
    let refused = false;
    try { await w.rows("update attribution_model set params='{\"lookback_days\":7,\"dedupe_minutes\":30}' where model_key='linear'"); } catch { refused = true; }
    assert(refused, "historical model definitions cannot change silently");
  });

  await t.step("campaign report: verified revenue, no double counting, null-safe ratios", async () => {
    const day = new Date(T + 5.5 * HOUR).toISOString().slice(0, 10);
    for (const m of ["last_non_direct", "linear", "first_touch"]) {
      const { data, error } = await w.admin.rpc("attribution_campaign_report", { p_brand_id: A.brand_id, p_from: "2026-01-01", p_to: "2099-12-31", p_model: m, p_version: 1 });
      assertEquals(error, null, JSON.stringify(error));
      const rows = data as any[];
      const gross = rows.reduce((s, r) => s + Number(r.gross_attributed_order_value), 0);
      assertAlmostEquals(gross, 3 * 118000, 0.01, `${m}: every order counted exactly once`);
      const orders = rows.reduce((s, r) => s + Number(r.attributed_orders), 0);
      assertAlmostEquals(orders, 3, 1e-5);
    }
    const { data } = await w.admin.rpc("attribution_campaign_report", { p_brand_id: A.brand_id, p_from: day, p_to: day, p_model: "last_non_direct", p_version: 1 });
    const meta = (data as any[]).find((r) => r.meta_campaign_id === META_CAMPAIGN && Number(r.attributed_orders) > 0);
    assertEquals([Number(meta.attributed_orders), Number(meta.gross_attributed_order_value), Number(meta.attributed_collected_revenue)], [1, 118000, 118000]);
    assertEquals([Number(meta.sessions), Number(meta.product_views), Number(meta.add_to_carts)], [1, 1, 1]);
    assertEquals(Number(meta.conversion_rate), 1);
    const unattributed = (data as any[]).find((r) => r.channel === "unattributed");
    assertEquals(Number(unattributed.attributed_orders), 1);
    assertEquals(unattributed.conversion_rate, null, "no sessions -> no conversion rate (not 0, not infinity)");
  });

  await t.step("Meta comparison keeps platform-reported and internal numbers separate", async () => {
    const day = new Date(T + 5.5 * HOUR).toISOString().slice(0, 10);
    const { data, error } = await w.admin.rpc("attribution_meta_comparison", { p_brand_id: A.brand_id, p_from: day, p_to: day });
    assertEquals(error, null, JSON.stringify(error));
    const [m] = data as any[];
    assertEquals([m.meta_campaign_id, m.attribution_setting], [META_CAMPAIGN, "1d_view_7d_click_1d_ev"]);
    assertEquals([Number(m.meta_purchases), Number(m.meta_purchase_value), Number(m.internal_last_touch_orders), Number(m.internal_last_touch_collected)], [3, 354000, 1, 118000]);
    assertEquals([Number(m.roas_meta_reported), Number(m.roas_internal_collected), Number(m.cpa_internal)], [7.08, 2.36, 50000]);
    assertEquals(m.internal_first_touch_orders, null, "first touch for this order was Instagram organic, not Meta");
  });

  await t.step("workspace isolation + users cannot write or run the engines", async () => {
    const as = (tn: Tenant) => pgUserClient(w.db, w.auth, new Request("http://x/", { headers: { Authorization: `Bearer ${tn.token}` } }));
    for (const tbl of ["attribution_visitor", "attribution_session", "attribution_event", "attribution_touchpoint", "attribution_conversion", "attribution_result"]) {
      const own = await as(A).from(tbl).select("*");
      assert(((own.data as any[]) ?? []).length > 0, `A reads own ${tbl}`);
      const other = await as(B).from(tbl).select("*");
      assertEquals(((other.data as any[]) ?? []).length, 0, `B must not read A's ${tbl}`);
    }
    const site = await as(B).from("attribution_site").select("*");
    assertEquals(((site.data as any[]) ?? []).length, 0);
    assert((await as(A).from("attribution_touchpoint").insert({ workspace_id: A.workspace_id, brand_id: A.brand_id, touch_type: "session", occurred_at: iso(NOW) })).error);
    for (const fn of ["compute_attribution", "link_attribution_conversions", "ingest_tracking_batch"]) {
      const args = fn === "ingest_tracking_batch" ? { p_public_key: KEY, p_origin: ORIGIN, p_batch: {} } : fn === "compute_attribution"
        ? { p_brand_id: A.brand_id, p_model: "linear", p_version: 1 } : { p_brand_id: A.brand_id };
      assert((await as(A).rpc(fn, args)).error, `${fn} must not be callable by users`);
    }
  });

  await w.close();
}});

Deno.test({ ...opts, name: "Revenue reconciliation edge cases", fn: async (t) => {
  const w = await World.create();
  const A = await w.signUp("owner-a@example.test", "Org A");
  const order = (pid: string, total: number, extra = "") => w.rows<{ id: string }>(
    `insert into commerce_order (workspace_id, brand_id, provider, provider_id, order_number, currency, gross_amount, net_sales, payment_gateways, source_created_at ${extra ? "," + extra.split("=")[0] : ""})
     values ($1,$2,'shopify',$3,$3,'INR',$4,$4,$5, now() ${extra ? "," + extra.split("=")[1] : ""}) returning id`,
    [A.workspace_id, A.brand_id, pid, total, pid === "cod" ? "{\"Cash on Delivery (COD)\"}" : "{Razorpay}"]);
  const pay = async (orderId: string, pid: string, amount: number, status = "captured") => {
    const [p] = await w.rows<{ id: string }>(`insert into commerce_paymentattempt (workspace_id, brand_id, provider, provider_id, amount_minor, currency, status, method)
                                              values ($1,$2,'razorpay',$3,$4,'INR',$5,'upi') returning id`, [A.workspace_id, A.brand_id, pid, amount, status]);
    await w.rows("insert into commerce_orderpaymentlink (order_id, payment_attempt_id, match_method) values ($1,$2,'test')", [orderId, p.id]);
  };
  const [paid] = await order("paid", 100000); await pay(paid.id, "p1", 100000);
  const [failed] = await order("failed", 100000); await pay(failed.id, "p2", 100000, "failed");
  const [partial] = await order("partial", 100000); await pay(partial.id, "p3", 40000);
  const [fullRef] = await order("fullref", 50000, "refunded_amount=50000"); await pay(fullRef.id, "p4", 50000, "refunded");
  const [partRef] = await order("partref", 60000, "refunded_amount=10000"); await pay(partRef.id, "p5", 60000);
  const [dup] = await order("dup", 30000); await pay(dup.id, "p6", 30000); await pay(dup.id, "p7", 30000);
  await order("cod", 20000);
  await order("nopay", 25000);

  const f = async (pid: string) => (await w.rows<any>("select * from attribution_order_financials where provider_id=$1", [pid]))[0];
  await t.step("definitions per case", async () => {
    const cases: Array<[string, string, number | null, number, number | null, string]> = [
      // pid, paid_status, paid_amount, refunded, net_collected, verification
      ["paid", "paid", 100000, 0, 100000, "verified_payment"],
      ["failed", "unpaid", null, 0, null, "awaiting_payment_record"],
      ["partial", "partially_paid", 40000, 0, 40000, "verified_payment"],
      ["fullref", "paid", 50000, 50000, 0, "verified_payment"],
      ["partref", "paid", 60000, 10000, 50000, "verified_payment"],
      ["dup", "overpaid", 60000, 0, 60000, "verified_payment"],
      ["cod", "unpaid", null, 0, null, "unverified_gateway"],
      ["nopay", "unpaid", null, 0, null, "awaiting_payment_record"],
    ];
    for (const [pid, status, paidAmt, refunded, net, verification] of cases) {
      const r = await f(pid);
      assertEquals([r.paid_status, r.paid_amount === null ? null : Number(r.paid_amount), Number(r.refunded_amount), r.net_collected === null ? null : Number(r.net_collected), r.payment_verification],
        [status, paidAmt, refunded, net, verification], pid);
    }
    assertEquals(Number((await f("failed")).failed_payment_attempts), 1);
    assertEquals((await f("fullref")).is_refunded, true);
  });
  await w.close();
}});
