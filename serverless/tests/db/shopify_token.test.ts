// Shopify automatic token renewal: each sync and connection test exchanges the app's Client ID and Client
// secret for a fresh Admin API token (client credentials grant). [MOCKED Shopify (scripted) + LOCAL DB]
import { assert, assertEquals } from "jsr:@std/assert@1";
import { call, json, type Tenant, World } from "../helpers/world.ts";
import { shopifyOrder } from "../helpers/payloads.ts";
import { createHandler as shopifySync } from "../../supabase/functions/shopify-sync/handler.ts";
import { createHandler as testConn } from "../../supabase/functions/test-connection/handler.ts";

const opts = { sanitizeResources: false, sanitizeOps: false };
const body = (t: Tenant, extra: Record<string, unknown> = {}) => ({ workspace_id: t.workspace_id, brand_id: t.brand_id, ...extra });
const TOKEN_URL = /test-store\.myshopify\.com\/admin\/oauth\/access_token/;
const ORDERS_URL = /test-store\.myshopify\.com\/admin\/api\/2024-10\/orders\.json/;

Deno.test({ ...opts, name: "Shopify automatic token renewal", fn: async (t) => {
  const w = await World.create();
  const A = await w.signUp("owner-shopify-token@example.test", "Shopify Token Org");
  const integ = await w.addIntegration(A, "shopify", {
    shop_domain: "test-store.myshopify.com",
    client_id: "client-id-123",
    client_secret: "shpss_client_secret_456",
  });
  const h = () => shopifySync(w.deps());

  await t.step("sync exchanges the Client ID and secret for a token and uses it for the orders request", async () => {
    w.http.on(TOKEN_URL, () => json({ access_token: "shpat_fresh_1", scope: "read_orders", expires_in: 86399 }));
    w.http.on(ORDERS_URL, () => json({ orders: [shopifyOrder(1)] }));
    const r = await call(h(), "shopify-sync", { token: A.token, body: body(A) });
    assertEquals(r.status, 200, JSON.stringify(r.body));
    assertEquals(r.body.data.records_created, 1);

    const tokenCall = w.http.calls.find((c) => TOKEN_URL.test(c.url))!;
    assertEquals(tokenCall.method, "POST");
    const form = new URLSearchParams(tokenCall.body ?? "");
    assertEquals(form.get("grant_type"), "client_credentials");
    assertEquals(form.get("client_id"), "client-id-123");
    assertEquals(form.get("client_secret"), "shpss_client_secret_456");

    const ordersCall = w.http.calls.find((c) => ORDERS_URL.test(c.url))!;
    assertEquals(ordersCall.headers.get("X-Shopify-Access-Token"), "shpat_fresh_1");
  });

  await t.step("every run requests a new token (renewal), so an expired token is never reused", async () => {
    w.http.routes = [];
    w.http.calls = [];
    w.http.on(TOKEN_URL, () => json({ access_token: "shpat_fresh_2", expires_in: 86399 }));
    w.http.on(ORDERS_URL, () => json({ orders: [] }));
    const r = await call(h(), "shopify-sync", { token: A.token, body: body(A, { days: 30 }) });
    assertEquals(r.status, 200, JSON.stringify(r.body));
    assert(w.http.calls.some((c) => TOKEN_URL.test(c.url)), "a token must be requested on this run");
    assertEquals(w.http.calls.find((c) => ORDERS_URL.test(c.url))!.headers.get("X-Shopify-Access-Token"), "shpat_fresh_2");
  });

  await t.step("rejected Client secret -> 401 with a clear message, and the card shows the error", async () => {
    w.http.routes = [];
    w.http.on(TOKEN_URL, () => json({ error: "invalid_client", error_description: "The client credentials are invalid" }, 400));
    const r = await call(h(), "shopify-sync", { token: A.token, body: body(A) });
    assertEquals(r.status, 401);
    assert(String(r.body.error).includes("rejected the Client ID or Client secret"), JSON.stringify(r.body));
    const [row] = await w.rows<any>("select status, last_error_message from integrations_integration where id=$1", [integ]);
    assertEquals(row.status, "error");
    assert(String(row.last_error_message).includes("Client secret"), row.last_error_message);
  });

  await t.step("unknown Client ID (Shopify HTML error page) -> 401 with the 'not recognised' reason", async () => {
    w.http.routes = [];
    w.http.on(TOKEN_URL, () => new Response("<html><title>400 - Oauth error application_cannot_be_found</title></html>", { status: 400, headers: { "Content-Type": "text/html" } }));
    const r = await call(h(), "shopify-sync", { token: A.token, body: body(A) });
    assertEquals(r.status, 401);
    assert(String(r.body.error).includes("does not recognise this Client ID"), JSON.stringify(r.body));
  });

  await t.step("connection test with Client ID and secret: fresh token is used for the shop check", async () => {
    w.http.routes = [];
    w.http.on(TOKEN_URL, () => json({ access_token: "shpat_test_3", expires_in: 86399 }));
    w.http.on(/test-store\.myshopify\.com\/admin\/api\/2024-10\/shop\.json/, () => json({ shop: { name: "Test Store", myshopify_domain: "test-store.myshopify.com" } }));
    const r = await call(testConn(w.deps()), "test-connection", {
      token: A.token,
      body: { provider: "shopify", workspace_id: A.workspace_id, brand_id: A.brand_id,
        credentials: { shop_domain: "test-store.myshopify.com", client_id: "client-id-123", client_secret: "shpss_client_secret_456" } },
    });
    assertEquals(r.status, 200, JSON.stringify(r.body));
    assertEquals(r.body.data.connection_status, "connected");
    assertEquals(w.http.calls.at(-1)!.headers.get("X-Shopify-Access-Token"), "shpat_test_3");
  });

  await w.close();
}});
