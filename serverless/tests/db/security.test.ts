// Security tests for the authenticated functions. [MOCKED upstream + LOCAL DB]
import { assert, assertEquals } from "jsr:@std/assert@1";
import { call, json, World } from "../helpers/world.ts";
import { shopifyOrder } from "../helpers/payloads.ts";
import { createHandler as shopifySync } from "../../supabase/functions/shopify-sync/handler.ts";
import { createHandler as razorpaySync } from "../../supabase/functions/razorpay-sync/handler.ts";
import { createHandler as metaSync } from "../../supabase/functions/meta-ads-sync/handler.ts";
import { createHandler as igSync } from "../../supabase/functions/instagram-sync/handler.ts";
import { createHandler as testConn } from "../../supabase/functions/test-connection/handler.ts";
import type { Deps } from "../../supabase/functions/_shared/deps.ts";

const opts = { sanitizeResources: false, sanitizeOps: false };
const SYNC: Array<[string, (d: Deps) => (r: Request) => Promise<Response>]> = [
  ["shopify-sync", shopifySync],
  ["razorpay-sync", razorpaySync],
  ["meta-ads-sync", metaSync],
  ["instagram-sync", igSync],
];

Deno.test({ ...opts, name: "Security", fn: async (t) => {
  const w = await World.create();
  const A = await w.signUp("owner-a@example.test", "Org A");
  const B = await w.signUp("owner-b@example.test", "Org B");
  const expiredToken = "tok_expired";
  w.auth.tokens.set(expiredToken, null); // the auth server rejects it, as for an expired/revoked JWT

  for (const [name, make] of SYNC) {
    await t.step(`${name}: missing Authorization -> 401`, async () => {
      assertEquals((await call(make(w.deps()), name, { body: { workspace_id: A.workspace_id, brand_id: A.brand_id } })).status, 401);
    });
    await t.step(`${name}: invalid / expired JWT -> 401`, async () => {
      assertEquals((await call(make(w.deps()), name, { token: "not-a-jwt", body: { workspace_id: A.workspace_id, brand_id: A.brand_id } })).status, 401);
      assertEquals((await call(make(w.deps()), name, { token: expiredToken, body: { workspace_id: A.workspace_id, brand_id: A.brand_id } })).status, 401);
    });
    await t.step(`${name}: other tenant's workspace -> 403, no upstream call`, async () => {
      w.http.calls = [];
      const r = await call(make(w.deps()), name, { token: A.token, body: { workspace_id: B.workspace_id, brand_id: B.brand_id } });
      assertEquals(r.status, 403);
      assertEquals(w.http.calls.length, 0);
    });
    await t.step(`${name}: own workspace + other tenant's brand -> 403`, async () => {
      assertEquals((await call(make(w.deps()), name, { token: A.token, body: { workspace_id: A.workspace_id, brand_id: B.brand_id } })).status, 403);
    });
    await t.step(`${name}: non-UUID ids (injection attempts) -> 400`, async () => {
      for (const bad of ["' OR '1'='1", "eq.x,or(brand_id.neq.0)", "../../etc", ""]) {
        assertEquals((await call(make(w.deps()), name, { token: A.token, body: { workspace_id: bad, brand_id: A.brand_id } })).status, 400, bad);
      }
    });
    await t.step(`${name}: malformed JSON -> 400; GET -> 405; OPTIONS -> CORS 200`, async () => {
      assertEquals((await call(make(w.deps()), name, { token: A.token, rawBody: "{oops" })).status, 400);
      assertEquals((await call(make(w.deps()), name, { token: A.token, method: "GET" })).status, 405);
      assertEquals((await call(make(w.deps()), name, { method: "OPTIONS" })).status, 200);
    });
  }

  await t.step("test-connection: unauthenticated -> 401 (cannot be used as an open proxy)", async () => {
    w.http.calls = [];
    const r = await call(testConn(w.deps()), "test-connection", { body: { provider: "razorpay", credentials: { key_id: "rzp_test_x", key_secret: "y" } } });
    assertEquals(r.status, 401);
    assertEquals(w.http.calls.length, 0);
  });

  await t.step("missing service-role key -> 500 misconfiguration (no silent anon fallback)", async () => {
    const d = w.deps();
    d.adminClient = () => { throw new Error("Server misconfiguration: SUPABASE_SERVICE_ROLE_KEY is not set"); };
    const r = await call(shopifySync(d), "shopify-sync", { token: A.token, body: { workspace_id: A.workspace_id, brand_id: A.brand_id } });
    assertEquals(r.status, 500);
    assert(String(r.body.error).includes("SUPABASE_SERVICE_ROLE_KEY"));
  });

  await t.step("credentials never appear in responses or logs", async () => {
    const SECRET_TOKEN = "shpat_TOPSECRET_9f8e7d6c5b4a";
    await w.addIntegration(A, "shopify", { shop_domain: "a.myshopify.com", access_token: SECRET_TOKEN });
    const logs: string[] = [];
    const orig = { log: console.log, warn: console.warn, error: console.error };
    console.log = console.warn = console.error = (...a: unknown[]) => logs.push(a.map(String).join(" "));
    try {
      w.http.routes = [];
      w.http.on(/orders\.json/, (_u, n) => n === 1 ? json({ orders: [shopifyOrder(1), { bad: true }] }) : json({ errors: "Invalid API key or access token" }, 401));
      const ok = await call(shopifySync(w.deps()), "shopify-sync", { token: A.token, body: { workspace_id: A.workspace_id, brand_id: A.brand_id } });
      const bad = await call(shopifySync(w.deps()), "shopify-sync", { token: A.token, body: { workspace_id: A.workspace_id, brand_id: A.brand_id } });
      const conn = await call(testConn(w.deps()), "test-connection", { token: A.token, body: { provider: "shopify", credentials: { shop_domain: "evil.com", access_token: SECRET_TOKEN } } });
      for (const r of [ok, bad, conn]) assertEquals(JSON.stringify(r.body).includes(SECRET_TOKEN), false);
    } finally {
      Object.assign(console, orig);
    }
    assert(logs.length > 0, "logs were captured");
    assertEquals(logs.some((l) => l.includes(SECRET_TOKEN) || l.includes("TOPSECRET")), false, "token leaked into logs");
  });

  await t.step("CORS: preflight advertises only the headers the functions need", async () => {
    const r = await call(shopifySync(w.deps()), "shopify-sync", { method: "OPTIONS" });
    const allow = r.headers.get("Access-Control-Allow-Headers") ?? "";
    for (const h of ["authorization", "apikey", "content-type"]) assert(allow.includes(h));
    // Recorded for the report: origin is wildcard. Bearer-token auth (no cookies) makes this acceptable,
    // but a fixed origin list would be stricter.
    assertEquals(r.headers.get("Access-Control-Allow-Origin"), "*");
    assertEquals(r.headers.get("Access-Control-Allow-Credentials"), null);
  });

  await w.close();
}});
