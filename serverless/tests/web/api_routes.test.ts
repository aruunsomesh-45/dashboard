// Next.js API routes (Vercel functions) end-to-end: auth, tenancy, data, credential storage, and
// frontend -> Edge Function -> (scripted) Shopify. [REAL route code + LOCAL PGlite DB + in-process fakes]
import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";
import { cookieValue, hit, WebWorld } from "./harness.ts";
import { json } from "../helpers/world.ts";
import { shopifyOrder } from "../helpers/payloads.ts";

const opts = { sanitizeResources: false, sanitizeOps: false };

Deno.test({ ...opts, name: "Next.js API routes", fn: async (t) => {
  const ww = await WebWorld.create();
  const w = ww.w;
  // Route modules read env at import time: import after the harness has set it.
  const api = await import("../../../frontend/src/app/api/[[...path]]/route.ts");
  const login = await import("../../../frontend/src/app/api/auth/login/route.ts");
  const me = await import("../../../frontend/src/app/api/auth/me/route.ts");
  const logout = await import("../../../frontend/src/app/api/auth/logout/route.ts");
  const register = await import("../../../frontend/src/app/api/auth/register/route.ts");

  const A = await ww.tenant("owner-a@example.test", "Org A");
  const B = await ww.tenant("owner-b@example.test", "Org B");
  const V = await ww.tenant("viewer@example.test", "Viewer Home");
  await w.addMember(A.workspace_id, V.user.id, "viewer");
  const cA = { "sb-access-token": A.token, "sb-refresh-token": A.refresh };
  const cB = { "sb-access-token": B.token };
  const cV = { "sb-access-token": V.token };
  const brandA = `/api/w/${A.slug}/b/${A.brand_id}`;

  // ── seed brand A ──────────────────────────────────────────────────────────
  const now = new Date();
  const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();
  const { rows: [cust] } = await w.db.query<{ id: string }>(
    `INSERT INTO public.commerce_customer (workspace_id, brand_id, provider, provider_id, email, first_name, last_name)
     VALUES ($1,$2,'shopify','c1','asha@example.test','Asha','K') RETURNING id`, [A.workspace_id, A.brand_id]);
  const order = (pid: string, net: number, created: string, extra = "") =>
    w.db.query(
      `INSERT INTO public.commerce_order (workspace_id, brand_id, provider, provider_id, order_number, customer_id, gross_amount, discount_amount, tax_amount, shipping_amount, net_sales, financial_status, fulfillment_status, source_created_at${extra ? ", cancelled_at" : ""})
       VALUES ($1,$2,'shopify',$3,$3,$4,$5,1000,500,200,$6,'paid','unfulfilled',$7${extra ? ", now()" : ""})`,
      [A.workspace_id, A.brand_id, pid, cust.id, net + 1700, net, created]);
  await order("#1001", 10000, daysAgo(2));
  await order("#1002", 20000, daysAgo(5));
  await order("#1003", 99999, daysAgo(3), "cancelled");
  await order("#0999", 50000, daysAgo(60)); // outside the 30-day window
  await w.db.query(
    `INSERT INTO public.commerce_paymentattempt (workspace_id, brand_id, provider, provider_id, amount_minor, status, method, source_created_at)
     VALUES ($1,$2,'razorpay','pay_1',10000,'captured','upi',now()), ($1,$2,'razorpay','pay_2',20000,'captured','card',now()),
            ($1,$2,'razorpay','pay_3',5000,'captured','upi',now()),   ($1,$2,'razorpay','pay_4',7000,'failed','card',now())`,
    [A.workspace_id, A.brand_id]);
  await w.db.query(
    `INSERT INTO public.analytics_factadsdaily (workspace_id, brand_id, fact_date, spend_minor, impressions, clicks, attributed_conversions, attributed_revenue_minor)
     VALUES ($1,$2,current_date - 1, 10000, 5000, 100, 2, 30000)`, [A.workspace_id, A.brand_id]);

  // ── authentication boundary ───────────────────────────────────────────────
  await t.step("no session -> 401 on every brand endpoint (was 200 with service-role data)", async () => {
    for (const a of ["shopify/stats", "payments/stats", "payments/transactions", "metrics", "integrations", "marketing/stats", "logistics/summary"]) {
      const r = await hit(api, `${brandA}/${a}`);
      assertEquals(r.status, 401, a);
    }
    assertEquals((await hit(api, `/api/w/${A.slug}/members`)).status, 401);
  });

  await t.step("forged / expired access token without refresh cookie -> 401", async () => {
    assertEquals((await hit(api, `${brandA}/shopify/stats`, { cookies: { "sb-access-token": "forged" } })).status, 401);
    assertEquals((await hit(api, `${brandA}/shopify/stats`, { cookies: { sessionid: "anything" } })).status, 401);
  });

  await t.step("expired access token + valid refresh cookie -> 200 and rotated cookies", async () => {
    const r = await hit(api, `${brandA}/metrics`, { cookies: { "sb-access-token": "expired", "sb-refresh-token": A.refresh } });
    assertEquals(r.status, 200);
    const newAccess = cookieValue(r.setCookies, "sb-access-token");
    assert(newAccess && newAccess !== "expired");
    assertEquals(cookieValue(r.setCookies, "sessionid"), newAccess);
    assert(cookieValue(r.setCookies, "sb-refresh-token"));
    // refresh tokens rotate: the old one is now dead
    assertEquals((await hit(api, `${brandA}/metrics`, { cookies: { "sb-access-token": "expired", "sb-refresh-token": A.refresh } })).status, 401);
  });

  // ── tenant isolation ──────────────────────────────────────────────────────
  await t.step("user B cannot read brand A (via A's slug or B's slug)", async () => {
    assertEquals((await hit(api, `${brandA}/shopify/stats`, { cookies: cB })).status, 404);
    assertEquals((await hit(api, `/api/w/${B.slug}/b/${A.brand_id}/shopify/stats`, { cookies: cB })).status, 404);
    assertEquals((await hit(api, `/api/w/${A.slug}/members`, { cookies: cB })).status, 404);
  });

  await t.step("member of A cannot use A's slug with B's brand id; malformed brand id -> 404", async () => {
    assertEquals((await hit(api, `/api/w/${A.slug}/b/${B.brand_id}/payments/stats`, { cookies: { "sb-access-token": A.token } })).status, 404);
    assertEquals((await hit(api, `/api/w/${A.slug}/b/not-a-uuid/payments/stats`, { cookies: { "sb-access-token": A.token } })).status, 404);
  });

  await t.step("suspended account -> 403", async () => {
    const S = await ww.tenant("suspended@example.test", "S Org");
    await w.db.query(`UPDATE public.accounts_user SET is_active = false WHERE id = $1`, [S.user.id]);
    assertEquals((await hit(api, `/api/w/${S.slug}/b/${S.brand_id}/metrics`, { cookies: { "sb-access-token": S.token } })).status, 403);
  });

  // ── data correctness (values computed from seeded rows) ───────────────────
  const cA2 = { "sb-access-token": A.token };
  await t.step("shopify/stats: 30-day window, cancelled excluded, brand + customer fields present", async () => {
    const r = await hit(api, `${brandA}/shopify/stats/?days=30`, { cookies: cA2 });
    assertEquals(r.status, 200);
    assertEquals(r.body.brand.id, A.brand_id); // page read data.brand.currency and crashed without it
    assertEquals(r.body.days, 30);
    assertEquals(r.body.metrics.order_count, 2);
    assertEquals(r.body.metrics.net_sales_minor, 30000);
    assertEquals(r.body.metrics.aov_minor, 15000);
    assertEquals(r.body.metrics.discount_total_minor, 2000);
    assertEquals(r.body.funnel.paid, 2);
    assertEquals(r.body.orders.length, 3); // recent list includes the cancelled order, like Shopify admin
    assertEquals(r.body.orders[0].customer_email, "asha@example.test");
    assertEquals(r.body.orders[0].customer_name, "Asha K");
    const r90 = await hit(api, `${brandA}/shopify/stats/?days=90`, { cookies: cA2 });
    assertEquals(r90.body.metrics.order_count, 3);
  });

  await t.step("payments/stats: real method split (no fabricated UPI), rates from attempts", async () => {
    const r = await hit(api, `${brandA}/payments/stats`, { cookies: cA2 });
    assertEquals(r.status, 200);
    assertEquals(r.body.payment_count, 3);
    assertEquals(r.body.attempt_count, 4);
    assertEquals(r.body.authorized_rate, 75);
    assertEquals(r.body.total_captured_minor, 35000);
    assertEquals(r.body.method_splits, { upi: 66.7, card: 33.3 });
    assertEquals(r.body.total_fees_minor, null);
    const empty = await hit(api, `/api/w/${B.slug}/b/${B.brand_id}/payments/stats`, { cookies: cB });
    assertEquals(empty.body.method_splits, {});
    assertEquals(empty.body.authorized_rate, null);
  });

  await t.step("payments/transactions: provider ids, no invented defaults", async () => {
    const r = await hit(api, `${brandA}/payments/transactions?limit=100`, { cookies: cA2 });
    assertEquals(r.body.length, 4);
    assert(r.body.every((p: any) => p.id.startsWith("pay_")));
    assert(r.body.some((p: any) => p.status === "failed"));
  });

  await t.step("metrics: blended ROAS from synced spend; disputes reported unavailable", async () => {
    const r = await hit(api, `${brandA}/metrics/?days=30`, { cookies: cA2 });
    assertEquals(r.body.metrics.blended_roas, { value: 3, available: true }); // 30000 / 10000
    assertEquals(r.body.metrics.orders_to_be_shipped, { value: 3, available: true });
    assertEquals(r.body.metrics.number_of_disputes.available, false);
  });

  await t.step("marketing/stats: not connected -> connected:false; connected -> real facts", async () => {
    assertEquals((await hit(api, `${brandA}/marketing/stats`, { cookies: cA2 })).body.connected, false);
    await w.addIntegration(A, "meta_ads", { ad_account_id: "act_1", access_token: "EAAB_synthetic" }, "act_1");
    const r = await hit(api, `${brandA}/marketing/stats`, { cookies: cA2 });
    assertEquals(r.body.connected, true);
    assertEquals(r.body.summary_30d.spend_minor, 10000);
    assertEquals(r.body.summary_30d.roas, 3);
    assertEquals(r.body.daily_trends.length, 1);
  });

  await t.step("pnl: server-side waterfall reconciles; ad spend follows the selected window; EBITDA not faked", async () => {
    // Another Meta fact 20 days ago: inside a 30-day window, outside a 7-day one.
    await w.db.query(
      `INSERT INTO public.analytics_factadsdaily (workspace_id, brand_id, fact_date, spend_minor, impressions, clicks, attributed_conversions, attributed_revenue_minor)
       VALUES ($1,$2,current_date - 20, 5000, 100, 1, 0, 0)`, [A.workspace_id, A.brand_id]);

    const r = await hit(api, `${brandA}/pnl/?days=30`, { cookies: cA2 });
    assertEquals(r.status, 200);
    const l = r.body.lines;
    // Seeded orders in window: net 10000 + 20000, each with 1000 discount, 500 tax, 200 shipping; cancelled excluded.
    assertEquals(l.gross_sales_minor, 32000); // net + discounts (Shopify total_price is already after discounts)
    assertEquals(l.discounts_minor, 2000);
    assertEquals(l.refunds_minor, 0);
    assertEquals(l.net_revenue_minor, 30000);
    assertEquals(l.gross_sales_minor - l.discounts_minor - l.refunds_minor, l.net_revenue_minor); // waterfall adds up
    assertEquals(l.cogs_minor, 10500); // 35%
    assertEquals(l.gross_margin_minor, 19500);
    assertEquals(l.ad_spend_minor, 15000); // both facts inside 30 days
    assertEquals(l.gateway_charges_minor, 600); // 2%
    assertEquals(l.shipping_costs_minor, 15000); // 2 orders x Rs 75
    assertEquals(l.cm1_minor, 19500 - 15000 - 600 - 15000);
    assertEquals(l.fixed_overhead_minor, null);
    assertEquals(l.ebitda_minor, null);
    assertEquals(r.body.pct_of_net.gross_sales, 106.7); // computed, not the old hard-coded 108.1%
    assertEquals(r.body.pct_of_net.cm1, -37); // -11100 / 30000
    assertEquals(r.body.memo, { tax_collected_minor: 1000, shipping_charged_minor: 400, partially_refunded_order_count: 0 });
    assertEquals(r.body.sources.ad_spend, "meta_ads");

    const r7 = await hit(api, `${brandA}/pnl/?days=7`, { cookies: cA2 });
    assertEquals(r7.body.lines.ad_spend_minor, 10000); // the 20-day-old spend is outside 7 days

    // Brand with no Meta connection and no orders: no ad spend line, no division by zero.
    const empty = await hit(api, `/api/w/${B.slug}/b/${B.brand_id}/pnl`, { cookies: cB });
    assertEquals(empty.status, 200);
    assertEquals(empty.body.lines.ad_spend_minor, null);
    assertEquals(empty.body.sources.ad_spend, "not_connected");
    assertEquals(empty.body.lines.cm1_minor, 0);
    assertEquals(empty.body.pct_of_net.cm1, null);

    assertEquals((await hit(api, `${brandA}/pnl`)).status, 401);
    assertEquals((await hit(api, `${brandA}/pnl`, { cookies: cB })).status, 404);
  });

  await t.step("refunded and voided orders are not revenue (shopify/stats, pnl, ROAS); real period comparison", async () => {
    await w.db.query(
      `INSERT INTO public.commerce_order (workspace_id, brand_id, provider, provider_id, order_number, gross_amount, discount_amount, tax_amount, shipping_amount, net_sales, financial_status, fulfillment_status, source_created_at)
       VALUES ($1,$2,'shopify','#1004','#1004',5700,1000,500,200,4000,'refunded','unfulfilled',$3),
              ($1,$2,'shopify','#1005','#1005',9700,0,500,200,9000,'voided','unfulfilled',$3),
              ($1,$2,'shopify','#1006','#1006',7700,0,500,200,7000,'partially_refunded','fulfilled',$3),
              ($1,$2,'shopify','#0998','#0998',51700,1000,500,200,50000,'paid','fulfilled',$4)`,
      [A.workspace_id, A.brand_id, daysAgo(1), daysAgo(45)]);
    const s = await hit(api, `${brandA}/shopify/stats/?days=30`, { cookies: cA2 });
    const m = s.body.metrics;
    assertEquals(m.refunds_minor, 4000);
    assertEquals(m.net_sales_minor, 37000); // 10000 + 20000 + 7000 (partial refund amount unknown)
    assertEquals(m.gross_sales_minor - m.discount_total_minor - m.refunds_minor, m.net_sales_minor);
    assertEquals(m.order_count, 3);
    assertEquals(m.refunded_order_count, 1);
    assertEquals(m.partially_refunded_order_count, 1);
    // The previous 30-day window (30-60 days ago) holds #0998 (net 50000).
    assertEquals(s.body.previous.net_sales_minor, 50000);
    assertEquals(s.body.change_pct.net_sales, -26); // (37000 - 50000) / 50000
    const p = await hit(api, `${brandA}/pnl/?days=30`, { cookies: cA2 });
    assertEquals(p.body.lines.refunds_minor, 4000);
    assertEquals(p.body.lines.net_revenue_minor, 37000);
    assertEquals(p.body.memo.partially_refunded_order_count, 1);
    // A 7-day window has no previous-period orders -> no invented trend.
    const s7 = await hit(api, `${brandA}/shopify/stats/?days=7`, { cookies: cA2 });
    assertEquals(s7.body.change_pct.net_sales, null);
  });

  await t.step("logistics: real (empty) shipment data; NDR action -> 501 instead of fake success", async () => {
    const s = await hit(api, `${brandA}/logistics/summary`, { cookies: cA2 });
    assertEquals(s.body.total_shipments, 0);
    assertEquals((await hit(api, `${brandA}/logistics/shipments?limit=100`, { cookies: cA2 })).body, []);
    assertEquals((await hit(api, `${brandA}/logistics/ndr/AWB1/action`, { method: "POST", cookies: cA2, body: {} })).status, 501);
  });

  // ── credential storage + frontend -> Edge Function -> Shopify ─────────────
  await t.step("integrations POST: viewer -> 403, nothing stored", async () => {
    const r = await hit(api, `/api/w/${A.slug}/b/${A.brand_id}/integrations/`, {
      method: "POST", cookies: cV, body: { provider: "shopify", credentials: { shop_domain: "x.myshopify.com", access_token: "shpat_x" } },
    });
    assertEquals(r.status, 403);
    assertEquals(await w.count("integrations_integration", "brand_id = $1 AND provider = 'shopify'", [A.brand_id]), 0);
  });

  await t.step("integrations POST: missing encryption key -> 503 (fails loudly, stores nothing)", async () => {
    const saved = Deno.env.get("INTEGRATION_ENCRYPTION_KEY")!;
    Deno.env.delete("INTEGRATION_ENCRYPTION_KEY");
    try {
      const r = await hit(api, `${brandA}/integrations/`, { method: "POST", cookies: cA2, body: { provider: "shopify", credentials: { access_token: "shpat_x" } } });
      assertEquals(r.status, 503);
    } finally {
      Deno.env.set("INTEGRATION_ENCRYPTION_KEY", saved);
    }
  });

  await t.step("integrations POST (owner) stores AES-GCM ciphertext the Edge Function can decrypt; sync-now ingests via user JWT", async () => {
    const save = await hit(api, `${brandA}/integrations/`, {
      method: "POST", cookies: cA2,
      body: { provider: "shopify", account_identifier: "test-store.myshopify.com", credentials: { shop_domain: "test-store.myshopify.com", access_token: "shpat_synthetic", webhook_secret: "shpss_synthetic" } },
    });
    assertEquals(save.status, 200);
    assertEquals(save.body.status, "connected");
    const [row] = await w.rows<{ encrypted_credentials: Uint8Array }>(`SELECT encrypted_credentials FROM public.integrations_integration WHERE brand_id = $1 AND provider = 'shopify'`, [A.brand_id]);
    assert(row.encrypted_credentials.length > 28);
    assert(!new TextDecoder().decode(row.encrypted_credentials).includes("shpat_synthetic"), "token must not be stored in clear");

    w.http.on(/test-store\.myshopify\.com\/admin\/api\/2024-10\/orders\.json/, () =>
      json({ orders: [shopifyOrder(7001, { created_at: new Date().toISOString() }), shopifyOrder(7002, { created_at: new Date().toISOString() })] }));
    const sync = await hit(api, `${brandA}/shopify/sync-now/`, { method: "POST", cookies: cA2 });
    assertEquals(sync.status, 200, JSON.stringify(sync.body));
    assertMatch(sync.body.message, /2 created/);
    const call = ww.edgeCalls.at(-1)!;
    assertEquals(call.fn, "shopify-sync");
    assertEquals(call.auth, `Bearer ${A.token}`); // the user's JWT, never the service-role key
    assertEquals(call.body, { workspace_id: A.workspace_id, brand_id: A.brand_id });
    assertEquals(await w.count("commerce_order", "brand_id = $1 AND provider_id IN ('7001','7002')", [A.brand_id]), 2);
  });

  await t.step("integrations POST: partial re-save keeps stored secrets (sync still works)", async () => {
    const r = await hit(api, `${brandA}/integrations/`, {
      method: "POST", cookies: cA2, body: { provider: "shopify", account_identifier: "test-store.myshopify.com", credentials: { shop_domain: "test-store.myshopify.com", access_token: "" } },
    });
    assertEquals(r.status, 200);
    assertEquals((await hit(api, `${brandA}/shopify/sync-now/`, { method: "POST", cookies: cA2 })).status, 200);
  });

  await t.step("integrations GET lists without credentials; unsupported provider -> 400", async () => {
    const r = await hit(api, `${brandA}/integrations/`, { cookies: cA2 });
    const shop = r.body.find((i: any) => i.provider === "shopify");
    assertEquals(shop.status, "connected");
    assertEquals(shop.provider_display, "Shopify");
    assert(!("encrypted_credentials" in shop));
    assertEquals((await hit(api, `${brandA}/integrations/`, { method: "POST", cookies: cA2, body: { provider: "unknown_courier", credentials: { a: "b" } } })).status, 400);
    // Delhivery is a supported provider: the owner can save its token (stored encrypted, never returned).
    const saved = await hit(api, `${brandA}/integrations/`, { method: "POST", cookies: cA2, body: { provider: "delhivery", account_identifier: "DLH_TEST", credentials: { api_token: "dlv_web_token" } } });
    assertEquals(saved.status, 200, JSON.stringify(saved.body));
  });

  await t.step("integrations DELETE: viewer 403; owner disconnects and wipes credentials", async () => {
    assertEquals((await hit(api, `${brandA}/integrations/?provider=shopify`, { method: "DELETE", cookies: cV })).status, 403);
    const r = await hit(api, `${brandA}/integrations/?provider=shopify`, { method: "DELETE", cookies: cA2 });
    assertEquals(r.status, 200);
    const [row] = await w.rows<{ status: string; encrypted_credentials: unknown }>(`SELECT status, encrypted_credentials FROM public.integrations_integration WHERE brand_id = $1 AND provider = 'shopify'`, [A.brand_id]);
    assertEquals(row.status, "disconnected");
    assertEquals(row.encrypted_credentials, null);
    // Edge Function now refuses: integration has no token
    const s = await hit(api, `${brandA}/shopify/sync-now/`, { method: "POST", cookies: cA2 });
    assertEquals(s.status, 400);
  });

  await t.step("sync-now for a brand the caller does not own -> 404, Edge Function never called", async () => {
    const before = ww.edgeCalls.length;
    assertEquals((await hit(api, `${brandA}/shopify/sync-now/`, { method: "POST", cookies: cB })).status, 404);
    assertEquals(ww.edgeCalls.length, before);
  });

  // ── team / account features ───────────────────────────────────────────────
  await t.step("members: lists users of the caller's workspace", async () => {
    const r = await hit(api, `/api/w/${A.slug}/members/`, { cookies: cV });
    assertEquals(r.status, 200);
    const emails = r.body.map((m: any) => m.user.email).sort();
    assertEquals(emails, ["owner-a@example.test", "viewer@example.test"]);
  });

  await t.step("account routes require a session; unknown path 404", async () => {
    assertEquals((await hit(api, `/api/v1/security/mfa/setup/`, { method: "POST" })).status, 401);
    assertEquals((await hit(api, `/api/v1/security/mfa/status/`)).status, 401);
    assertEquals((await hit(api, `/api/w/${A.slug}/invites/`, { method: "POST", body: { email: "x@example.test" } })).status, 401);
    assertEquals((await hit(api, `/api/w/invites/accept/`, { method: "POST", body: { token: "x" } })).status, 401);
    assertEquals((await hit(api, `/api/something/else`, { cookies: cA2 })).status, 404);
  });

  // ── auth routes ───────────────────────────────────────────────────────────
  await t.step("login: valid -> 200 + HTTP-only session cookies; wrong password -> 400 generic", async () => {
    const r = await hit(login, "/api/auth/login/", { method: "POST", body: { email: "Owner-A@example.test ", password: A.password } });
    assertEquals(r.status, 200);
    assertEquals(r.body.workspaces[0].slug, A.slug);
    const access = cookieValue(r.setCookies, "sb-access-token")!;
    assert(access);
    assert(r.setCookies.some((c) => c.startsWith("sb-access-token=") && /HttpOnly/i.test(c)));
    const m = await hit(me, "/api/auth/me", { cookies: { "sb-access-token": access } });
    assertEquals([m.status, m.body.user.email], [200, "owner-a@example.test"]);

    const bad = await hit(login, "/api/auth/login/", { method: "POST", body: { email: "owner-a@example.test", password: "nope" } });
    assertEquals([bad.status, bad.body.error], [400, "Invalid email or password."]);
  });

  await t.step("me: no cookie -> 401; logout revokes token and clears cookies", async () => {
    assertEquals((await hit(me, "/api/auth/me")).status, 401);
    const r = await hit(logout, "/api/auth/logout/", { method: "POST", cookies: { "sb-access-token": B.token } });
    assertEquals(r.status, 200);
    assert(ww.revoked.includes(B.token));
    assert(r.setCookies.some((c) => c.startsWith("sb-access-token=;") || /sb-access-token=.*Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(c)));
  });

  await t.step("register: exactly one workspace (trigger-provisioned, named from form); duplicate email rejected", async () => {
    const r = await hit(register, "/api/auth/register/", { method: "POST", body: { email: "new@example.test", password: "a-long-password", workspace_name: "Fresh Brand" } });
    assertEquals(r.status, 200, JSON.stringify(r.body));
    assertEquals(r.body.workspaces.length, 1);
    assertEquals(r.body.workspaces[0].name, "Fresh Brand");
    assertEquals(r.body.workspaces[0].brands.length, 1);
    const dup = await hit(register, "/api/auth/register/", { method: "POST", body: { email: "new@example.test", password: "x-long-password" } });
    assertEquals(dup.status, 400);
    const uid = ww.passwords.get("new@example.test")!.id;
    assertEquals(await w.count("tenancy_workspacemember", "user_id = $1", [uid]), 1);
  });

  ww.restore();
  await w.close();
}});
