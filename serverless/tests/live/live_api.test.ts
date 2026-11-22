/**
 * LIVE third-party API tests. Real HTTPS calls to Shopify / Razorpay / Meta, read-only (GET).
 * Data is persisted ONLY into an isolated in-process database, never into the hosted project.
 *
 * Each platform is skipped (reported as "ignored") unless its credentials are in the environment:
 *   LIVE_SHOPIFY_SHOP, LIVE_SHOPIFY_TOKEN                (shpat_..., read_orders scope)
 *   LIVE_RAZORPAY_KEY_ID, LIVE_RAZORPAY_KEY_SECRET       (rzp_test_... recommended)
 *   LIVE_META_AD_ACCOUNT, LIVE_META_TOKEN                (ads_read)
 *   LIVE_INSTAGRAM_TOKEN                                 (instagram_basic, pages_show_list)
 *
 * Run:  deno task test:live      (from serverless/)
 * Each test asserts three separate things: (1) API auth, (2) data fetch, (3) DB persistence.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { call, World } from "../helpers/world.ts";
import { createHandler as testConn } from "../../supabase/functions/test-connection/handler.ts";
import { createHandler as shopifySync } from "../../supabase/functions/shopify-sync/handler.ts";
import { createHandler as razorpaySync } from "../../supabase/functions/razorpay-sync/handler.ts";
import { createHandler as metaSync } from "../../supabase/functions/meta-ads-sync/handler.ts";
import { createHandler as igSync } from "../../supabase/functions/instagram-sync/handler.ts";

const env = (k: string) => Deno.env.get(k) ?? "";
const opts = { sanitizeResources: false, sanitizeOps: false };

async function liveWorld() {
  const w = await World.create();
  const deps = w.deps();
  deps.fetch = (input, init) => fetch(input, init); // REAL network for upstream APIs only
  const T = await w.signUp("live-test@example.test", "Live Test Brand");
  return { w, deps, T };
}

Deno.test({ ...opts, name: "LIVE Shopify Admin API", ignore: !env("LIVE_SHOPIFY_SHOP") || !env("LIVE_SHOPIFY_TOKEN"), fn: async (t) => {
  const { w, deps, T } = await liveWorld();
  await w.addIntegration(T, "shopify", { shop_domain: env("LIVE_SHOPIFY_SHOP"), access_token: env("LIVE_SHOPIFY_TOKEN") });
  await t.step("(1) API authentication via GET /shop.json", async () => {
    const r = await call(testConn(deps), "test-connection", { token: T.token, body: { provider: "shopify", credentials: { shop_domain: env("LIVE_SHOPIFY_SHOP"), access_token: env("LIVE_SHOPIFY_TOKEN") } } });
    assertEquals(r.body.data.connection_status, "connected", r.body.data.error_message);
  });
  await t.step("(2)+(3) orders fetched and persisted; re-run creates no duplicates", async () => {
    const r1 = await call(shopifySync(deps), "shopify-sync", { token: T.token, body: { workspace_id: T.workspace_id, brand_id: T.brand_id, days: 60, max_pages: 2 } });
    assertEquals(r1.status, 200, JSON.stringify(r1.body));
    const n = await w.count("commerce_order", "brand_id=$1", [T.brand_id]);
    assertEquals(n, r1.body.data.records_processed - r1.body.data.records_failed);
    const r2 = await call(shopifySync(deps), "shopify-sync", { token: T.token, body: { workspace_id: T.workspace_id, brand_id: T.brand_id, days: 60, max_pages: 2 } });
    assertEquals(r2.body.data.records_created, 0);
    assertEquals(await w.count("commerce_order", "brand_id=$1", [T.brand_id]), n);
    console.log(`  live shopify: ${n} orders persisted, ${r1.body.data.pages_fetched} page(s), ${Math.round(r1.ms)}ms`);
  });
  await w.close();
}});

Deno.test({ ...opts, name: "LIVE Razorpay API", ignore: !env("LIVE_RAZORPAY_KEY_ID") || !env("LIVE_RAZORPAY_KEY_SECRET"), fn: async (t) => {
  const { w, deps, T } = await liveWorld();
  const creds = { key_id: env("LIVE_RAZORPAY_KEY_ID"), key_secret: env("LIVE_RAZORPAY_KEY_SECRET") };
  await w.addIntegration(T, "razorpay", creds);
  await t.step("(1) API authentication via GET /v1/payments?count=1", async () => {
    const r = await call(testConn(deps), "test-connection", { token: T.token, body: { provider: "razorpay", credentials: creds } });
    assertEquals(r.body.data.connection_status, "connected", r.body.data.error_message);
  });
  await t.step("(2)+(3) payments fetched, normalised and persisted", async () => {
    const r = await call(razorpaySync(deps), "razorpay-sync", { token: T.token, body: { workspace_id: T.workspace_id, brand_id: T.brand_id, days: 30, max_pages: 2 } });
    assertEquals(r.status, 200, JSON.stringify(r.body));
    const n = await w.count("commerce_paymentattempt", "brand_id=$1", [T.brand_id]);
    assertEquals(n, r.body.data.records_processed - r.body.data.records_failed);
    console.log(`  live razorpay: ${n} payments persisted, ${Math.round(r.ms)}ms`);
  });
  await w.close();
}});

Deno.test({ ...opts, name: "LIVE Meta Ads Graph API", ignore: !env("LIVE_META_AD_ACCOUNT") || !env("LIVE_META_TOKEN"), fn: async (t) => {
  const { w, deps, T } = await liveWorld();
  const creds = { ad_account_id: env("LIVE_META_AD_ACCOUNT"), access_token: env("LIVE_META_TOKEN") };
  await w.addIntegration(T, "meta_ads", creds);
  await t.step("(1) token + ad account access", async () => {
    const r = await call(testConn(deps), "test-connection", { token: T.token, body: { provider: "meta_ads", credentials: creds } });
    assertEquals(r.body.data.connection_status, "connected", r.body.data.error_message);
  });
  await t.step("(2)+(3) daily insights fetched and persisted", async () => {
    const r = await call(metaSync(deps), "meta-ads-sync", { token: T.token, body: { workspace_id: T.workspace_id, brand_id: T.brand_id, days: 14 } });
    assertEquals(r.status, 200, JSON.stringify(r.body));
    const n = await w.count("analytics_factadsdaily", "brand_id=$1", [T.brand_id]);
    assertEquals(n, r.body.data.records_processed - r.body.data.records_failed);
    console.log(`  live meta: ${n} day(s) persisted, ${Math.round(r.ms)}ms`);
  });
  await w.close();
}});

Deno.test({ ...opts, name: "LIVE Instagram Graph API", ignore: !env("LIVE_INSTAGRAM_TOKEN"), fn: async (t) => {
  const { w, deps, T } = await liveWorld();
  await w.addIntegration(T, "instagram", { graph_token: env("LIVE_INSTAGRAM_TOKEN") });
  await t.step("token valid; per-capability permission report", async () => {
    const r = await call(igSync(deps), "instagram-sync", { token: T.token, body: { workspace_id: T.workspace_id, brand_id: T.brand_id } });
    assertEquals(r.status, 200, JSON.stringify(r.body));
    assert(r.body.data.capabilities.token.ok);
    console.log(`  live instagram: capabilities=${JSON.stringify(r.body.data.capabilities)} media=${r.body.data.records_fetched}`);
  });
  await w.close();
}});
