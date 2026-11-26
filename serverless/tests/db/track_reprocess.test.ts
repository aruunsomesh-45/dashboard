// Handler tests for the two functions without direct coverage until now:
//   track           - public storefront ingestion (no JWT): origin, consent, validation, idempotency
//   reprocess-raw   - re-runs failed raw payloads: auth, role, processors, idempotency
// [LOCAL DB (PGlite, real migrations + RPCs); no external calls]
import { assert, assertEquals } from "jsr:@std/assert@1";
import { call, type Tenant, World } from "../helpers/world.ts";
import { shopifyOrder } from "../helpers/payloads.ts";
import { createHandler as trackHandler } from "../../supabase/functions/track/handler.ts";
import { createHandler as reprocessHandler } from "../../supabase/functions/reprocess-raw/handler.ts";

const opts = { sanitizeResources: false, sanitizeOps: false };
const KEY = "pk_testtrack0123456789";
const ORIGIN = "https://shop.example.test";

const sid = (n: string) => `sess${n}-${"x".repeat(12)}`; // 16+ chars, matches the session-id rule
const batch = (over: Record<string, unknown> = {}) => ({
  k: KEY,
  visitor: "visitor-aaaaaaaaaaaaaaaa",
  consent: { analytics: true },
  session: {
    id: sid("1"),
    started_at: new Date().toISOString(),
    landing_url: `${ORIGIN}/?utm_source=meta&utm_campaign=spring&fbclid=AbCdEf123456`,
    referrer: "https://www.google.com/search?q=shoes",
    device: "mobile",
    browser: "chrome",
  },
  events: [
    { id: "evt-page-0001", name: "page_view", ts: new Date().toISOString(), seq: 1, url: `${ORIGIN}/` },
    { id: "evt-cart-0001", name: "add_to_cart", ts: new Date().toISOString(), seq: 2, url: `${ORIGIN}/p/1`, product: "gid://shopify/Product/42", cart: "cart-token-abc123?key=SECRETKEY9" },
  ],
  ...over,
});

const post = (h: (r: Request) => Promise<Response>, body: unknown, headers: Record<string, string> = {}) =>
  h(new Request("https://edge.test/track", {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));

Deno.test({ ...opts, name: "track (storefront ingestion)", fn: async (t) => {
  const w = await World.create();
  const A = await w.signUp("owner-track@example.test", "Track Org");
  await w.rows(`insert into attribution_site (workspace_id, brand_id, public_key, allowed_origins) values ($1,$2,$3,$4)`,
    [A.workspace_id, A.brand_id, KEY, `{${ORIGIN}}`]);
  const h = trackHandler(w.deps());
  const visitors = () => w.count("attribution_visitor", "brand_id=$1", [A.brand_id]);
  const sessions = () => w.count("attribution_session", "brand_id=$1", [A.brand_id]);

  await t.step("GET is not allowed (405)", async () => {
    const r = await h(new Request("https://edge.test/track", { method: "GET", headers: { origin: ORIGIN } }));
    assertEquals(r.status, 405);
  });

  await t.step("CORS preflight answered for the calling origin only", async () => {
    const r = await h(new Request("https://edge.test/track", { method: "OPTIONS", headers: { origin: ORIGIN } }));
    assertEquals(r.status, 204);
    assertEquals(r.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  });

  await t.step("no Origin header -> 403 (browser-only endpoint)", async () => {
    const r = await h(new Request("https://edge.test/track", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(batch()) }));
    assertEquals(r.status, 403);
  });

  await t.step("oversized body -> 413, malformed JSON -> 400", async () => {
    const big = await post(h, "x".repeat(70_000));
    assertEquals(big.status, 413);
    assertEquals((await post(h, "{not json")).status, 400);
  });

  await t.step("browser may not report money events (purchase) -> 400, nothing stored", async () => {
    const bad = batch({ events: [{ id: "evt-buy-00001", name: "purchase", ts: new Date().toISOString(), seq: 1, url: `${ORIGIN}/` }] });
    assertEquals((await post(h, bad)).status, 400);
    assertEquals(await visitors(), 0);
  });

  await t.step("unknown site key -> 403 and the reply does not reveal the key exists", async () => {
    const r = await post(h, batch({ k: "pk_unknownkey0123456789" }));
    assertEquals(r.status, 403);
    assertEquals((await r.json()).error, "Not allowed");
  });

  await t.step("origin not on the allow-list -> 403, nothing stored", async () => {
    const r = await post(h, batch(), { origin: "https://evil.example.test" });
    assertEquals(r.status, 403);
    assertEquals(await visitors(), 0);
  });

  await t.step("no analytics consent -> 202 stored:false, nothing stored", async () => {
    const r = await post(h, batch({ consent: { analytics: false } }));
    assertEquals(r.status, 202);
    assertEquals((await r.json()).data.stored, false);
    assertEquals(await visitors(), 0);
  });

  await t.step("valid batch with consent -> 202, visitor + session + events stored, attribution fields kept", async () => {
    const r = await post(h, batch());
    assertEquals(r.status, 202, await r.clone().text());
    const body = await r.json();
    assertEquals(body.data.accepted, 2);
    assertEquals(await visitors(), 1);
    assertEquals(await sessions(), 1);
    const [s] = await w.rows<any>("select utm_source, utm_campaign, referrer_domain, landing_path, click_ids from attribution_session where brand_id=$1", [A.brand_id]);
    assertEquals([s.utm_source, s.utm_campaign], ["meta", "spring"]);
    assertEquals(s.referrer_domain, "www.google.com");
    assertEquals(s.landing_path, "/");
    assertEquals(s.click_ids.fbclid, "AbCdEf123456");
    assertEquals(await w.count("attribution_event", "brand_id=$1", [A.brand_id]), 2);
  });

  await t.step("cart id is kept for order linking, but the ?key= secret is stripped before storage", async () => {
    const [e] = await w.rows<any>("select cart_token from attribution_event where event_name='add_to_cart' and brand_id=$1", [A.brand_id]);
    assertEquals(e.cart_token, "cart-token-abc123");
    assert(!JSON.stringify(e).includes("SECRETKEY9"), "cart key secret must not be stored");
  });

  await t.step("replaying the same batch is idempotent: duplicates counted, no new rows", async () => {
    const r = await post(h, batch());
    assertEquals(r.status, 202);
    const body = await r.json();
    assertEquals(body.data.duplicates, 2);
    assertEquals(body.data.accepted, 0);
    assertEquals(await w.count("attribution_event", "brand_id=$1", [A.brand_id]), 2);
    assertEquals(await sessions(), 1);
  });

  await t.step("a new session for a known visitor increments the visitor's session count", async () => {
    await post(h, batch({ session: { ...batch().session, id: sid("2") } }));
    assertEquals(await visitors(), 1);
    assertEquals(await sessions(), 2);
    const [v] = await w.rows<any>("select sessions_count from attribution_visitor where brand_id=$1", [A.brand_id]);
    assertEquals(Number(v.sessions_count), 2);
  });
}});

Deno.test({ ...opts, name: "reprocess-raw", fn: async (t) => {
  const w = await World.create();
  const O = await w.signUp("owner-rp@example.test", "Reprocess Org");
  const V = await w.signUp("viewer-rp@example.test", "Viewer Org");
  await w.addMember(O.workspace_id, V.user.id, "viewer");
  const h = () => reprocessHandler(w.deps());
  const run = (t2: Tenant, token: string | undefined, extra: Record<string, unknown> = {}) =>
    call(h(), "reprocess-raw", { token, body: { workspace_id: t2.workspace_id, brand_id: t2.brand_id, ...extra } });

  const failedRaw = (topic: string, payload: unknown, entity = "x") =>
    w.db.query(
      `INSERT INTO public.integrations_rawpayload (workspace_id, brand_id, provider, topic, entity_id, payload, processing_status)
       VALUES ($1,$2,$3,$4,$5,$6,'failed')`,
      [O.workspace_id, O.brand_id, topic.split("/")[0], topic.split("/")[1], entity, JSON.stringify(payload)]);

  await t.step("no credentials -> 401", async () => {
    assertEquals((await run(O, undefined)).status, 401);
  });

  await t.step("viewer in the workspace -> 403 (only owner/admin may reprocess)", async () => {
    assertEquals((await run(O, V.token)).status, 403);
  });

  await t.step("non-member of the workspace -> 403, nothing processed", async () => {
    const before = await w.count("integrations_rawpayload", "brand_id=$1", [O.brand_id]);
    assertEquals((await run(O, V.token, { limit: 5 })).status, 403);
    assertEquals(await w.count("integrations_rawpayload", "brand_id=$1", [O.brand_id]), before);
  });

  await t.step("owner reprocesses failed Shopify orders into commerce_order", async () => {
    await failedRaw("shopify/order", shopifyOrder(501), "501");
    await failedRaw("shopify/order", shopifyOrder(502), "502");
    const r = await run(O, O.token);
    assertEquals(r.status, 200, JSON.stringify(r.body));
    assertEquals(r.body.data.selected, 2);
    assertEquals(r.body.data.reprocessed, 2);
    assertEquals(r.body.data.still_failed, 0);
    assertEquals(await w.count("commerce_order", "brand_id=$1 AND provider_id IN ('501','502')", [O.brand_id]), 2);
    assert(r.body.data.reconciliation !== undefined);
  });

  await t.step("re-running is idempotent: no duplicate orders", async () => {
    await failedRaw("shopify/order", shopifyOrder(501), "501");
    const r = await run(O, O.token);
    assertEquals(r.body.data.reprocessed, 1);
    assertEquals(await w.count("commerce_order", "brand_id=$1 AND provider_id='501'", [O.brand_id]), 1);
  });

  await t.step("payload that still cannot be processed is counted as still_failed, not silently dropped", async () => {
    await failedRaw("shopify/order", { id: null }, "bad");
    const r = await run(O, O.token);
    assertEquals(r.body.data.still_failed, 1);
    assertEquals(r.body.data.reprocessed, 0);
  });

  await t.step("unknown provider/topic is marked skipped, not processed", async () => {
    await failedRaw("unknown/thing", { any: 1 }, "u1");
    const r = await run(O, O.token);
    assertEquals(r.body.data.skipped, 1);
    const [row] = await w.rows<any>("select processing_status from integrations_rawpayload where provider='unknown'");
    assertEquals(row.processing_status, "skipped");
  });

  await t.step("limit is respected and oldest failures go first", async () => {
    for (let i = 0; i < 3; i++) await failedRaw("shopify/order", shopifyOrder(600 + i), `60${i}`);
    const r = await run(O, O.token, { limit: 2 });
    assertEquals(r.body.data.selected, 2);
  });
}});
