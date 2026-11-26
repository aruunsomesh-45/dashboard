// Scheduled sync (Supabase Cron path): x-cron-secret auth, overlap lock, stale-run recovery,
// sync health view isolation, dispatcher privileges.
// [MOCKED upstream APIs + LOCAL DB (real migrations/RLS via PGlite)]. pg_cron/pg_net are not
// available in PGlite, so the schedules themselves are NOT exercised here; the SQL dispatcher's
// privileges and the Edge Function side of the contract are.
import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";
import { call, json, type Tenant, World } from "../helpers/world.ts";
import { razorpayPayment, shopifyOrder } from "../helpers/payloads.ts";
import { pgUserClient } from "../helpers/pg_supabase.ts";
import { createHandler as shopifySync } from "../../supabase/functions/shopify-sync/handler.ts";
import { createHandler as razorpaySync } from "../../supabase/functions/razorpay-sync/handler.ts";
import { isCronRequest } from "../../supabase/functions/_shared/cron.ts";

const opts = { sanitizeResources: false, sanitizeOps: false };
const SECRET = "test-cron-secret-0123456789abcdef-not-real";
const body = (t: Tenant, extra: Record<string, unknown> = {}) => ({ workspace_id: t.workspace_id, brand_id: t.brand_id, ...extra });

Deno.test("isCronRequest: header absent / valid / wrong / secret too short", () => {
  const req = (h?: string) => new Request("http://x/", { headers: h === undefined ? {} : { "x-cron-secret": h } });
  assertEquals(isCronRequest(req(), SECRET), false);
  assertEquals(isCronRequest(req(SECRET), SECRET), true);
  for (const [presented, secret] of [["nope", SECRET], [SECRET + "x", SECRET], ["short", "short"], ["", ""]]) {
    try {
      isCronRequest(req(presented), secret);
      throw new Error("expected 401");
    } catch (e) {
      assertEquals((e as { status?: number }).status, 401, `${presented} / ${secret}`);
    }
  }
});

Deno.test({ ...opts, name: "Scheduled sync via cron secret", fn: async (t) => {
  Deno.env.set("CRON_SECRET", SECRET);
  const w = await World.create();
  const A = await w.signUp("owner-a@example.test", "Org A");
  const B = await w.signUp("owner-b@example.test", "Org B");
  const shop = await w.addIntegration(A, "shopify", { shop_domain: "test-store.myshopify.com", access_token: "shpat_synthetic" });
  const rzp = await w.addIntegration(A, "razorpay", { key_id: "rzp_test_SYNTH", key_secret: "synthetic_secret" });
  await w.addIntegration(B, "razorpay", { key_id: "rzp_test_B", key_secret: "b" });

  await t.step("cron call without a user token syncs and records triggered_by=cron", async () => {
    w.http.on(/orders\.json/, () => json({ orders: [shopifyOrder(1), shopifyOrder(2)] }));
    const r = await call(shopifySync(w.deps()), "shopify-sync", { headers: { "x-cron-secret": SECRET }, body: body(A, { days: 2 }) });
    assertEquals(r.status, 200, JSON.stringify(r.body));
    assertEquals(r.body.data.records_processed, 2);
    const [run] = await w.rows<any>("select status, triggered_by from integrations_syncrun where integration_id=$1", [shop]);
    assertEquals([run.status, run.triggered_by], ["success", "cron"]);
  });

  await t.step("user-triggered run is still recorded as manual", async () => {
    w.http.routes = [];
    w.http.on(/api\.razorpay\.com/, () => json({ items: [razorpayPayment("pay_1")] }));
    const r = await call(razorpaySync(w.deps()), "razorpay-sync", { token: A.token, body: body(A) });
    assertEquals(r.status, 200, JSON.stringify(r.body));
    const [run] = await w.rows<any>("select triggered_by from integrations_syncrun where integration_id=$1", [rzp]);
    assertEquals(run.triggered_by, "manual");
  });

  await t.step("wrong cron secret -> 401, no upstream call, no sync run", async () => {
    w.http.calls = [];
    const before = await w.count("integrations_syncrun");
    const r = await call(shopifySync(w.deps()), "shopify-sync", { headers: { "x-cron-secret": "wrong" }, body: body(A) });
    assertEquals(r.status, 401);
    assertEquals(r.body.success, false);
    assertEquals(w.http.calls.length, 0);
    assertEquals(await w.count("integrations_syncrun"), before);
  });

  await t.step("wrong cron secret is rejected even alongside a valid user token", async () => {
    const r = await call(shopifySync(w.deps()), "shopify-sync", { token: A.token, headers: { "x-cron-secret": "wrong" }, body: body(A) });
    assertEquals(r.status, 401);
  });

  await t.step("cron mode is disabled when CRON_SECRET is unset", async () => {
    Deno.env.delete("CRON_SECRET");
    try {
      const r = await call(shopifySync(w.deps()), "shopify-sync", { headers: { "x-cron-secret": SECRET }, body: body(A) });
      assertEquals(r.status, 401);
    } finally {
      Deno.env.set("CRON_SECRET", SECRET);
    }
  });

  await t.step("cron call for a (workspace, brand) pair with no integration -> 404, nothing written", async () => {
    const r = await call(shopifySync(w.deps()), "shopify-sync", { headers: { "x-cron-secret": SECRET }, body: { workspace_id: B.workspace_id, brand_id: A.brand_id } });
    assertEquals(r.status, 404);
  });

  await t.step("overlap lock: a second run while one is running -> 409, no upstream call", async () => {
    await w.rows(
      "insert into integrations_syncrun (workspace_id, brand_id, integration_id, status, resource, started_at) values ($1,$2,$3,'running','orders', now())",
      [A.workspace_id, A.brand_id, shop],
    );
    w.http.calls = [];
    const r = await call(shopifySync(w.deps()), "shopify-sync", { headers: { "x-cron-secret": SECRET }, body: body(A) });
    assertEquals(r.status, 409, JSON.stringify(r.body));
    assertMatch(r.body.error, /already running/);
    assertEquals(w.http.calls.length, 0);
    // the database itself refuses a second running row
    let refused = false;
    try {
      await w.rows("insert into integrations_syncrun (workspace_id, brand_id, integration_id, status, resource) values ($1,$2,$3,'running','orders')", [A.workspace_id, A.brand_id, shop]);
    } catch { refused = true; }
    assert(refused, "uq_syncrun_one_running must reject a second running row");
  });

  await t.step("stale running run (>15 min) is closed and the new run proceeds", async () => {
    await w.rows("update integrations_syncrun set started_at = now() - interval '20 minutes' where status='running' and integration_id=$1", [shop]);
    w.http.routes = [];
    w.http.on(/orders\.json/, () => json({ orders: [shopifyOrder(3)] }));
    const r = await call(shopifySync(w.deps()), "shopify-sync", { headers: { "x-cron-secret": SECRET }, body: body(A) });
    assertEquals(r.status, 200, JSON.stringify(r.body));
    const stale = await w.rows<any>("select error_message from integrations_syncrun where integration_id=$1 and status='failed'", [shop]);
    assertEquals(stale.length, 1);
    assertMatch(stale[0].error_message, /Abandoned/);
    assertEquals(await w.count("integrations_syncrun", "integration_id=$1 and status='running'", [shop]), 0);
  });

  await t.step("integrations_sync_health: last success, failure streak, workspace isolation", async () => {
    await w.rows(
      "insert into integrations_syncrun (workspace_id, brand_id, integration_id, status, resource, started_at, finished_at, error_message) values ($1,$2,$3,'failed','orders', now()+interval '1 minute', now()+interval '1 minute', 'boom')",
      [A.workspace_id, A.brand_id, shop],
    );
    const [h] = await w.rows<any>("select * from integrations_sync_health where integration_id=$1", [shop]);
    assertEquals(h.last_run_status, "failed");
    assertEquals(h.last_run_error, "boom");
    assertEquals(h.consecutive_failures, 1);
    assert(h.last_success_at, "last_success_at must be set");
    assertEquals(h.is_running, false);

    const asA = pgUserClient(w.db, w.auth, new Request("http://x/", { headers: { Authorization: `Bearer ${A.token}` } }));
    const { data, error } = await asA.from("integrations_sync_health").select("integration_id, workspace_id");
    assertEquals(error, null, JSON.stringify(error));
    assertEquals((data as any[]).length, 2, "A sees exactly its own two integrations");
    assert((data as any[]).every((row) => row.workspace_id === A.workspace_id), "no rows from workspace B");
  });

  await t.step("dispatcher functions are not executable by anon/authenticated", async () => {
    const [p] = await w.rows<any>(`select
        has_function_privilege('anon', 'public.enqueue_scheduled_syncs(text, jsonb)', 'EXECUTE') anon_enq,
        has_function_privilege('authenticated', 'public.enqueue_scheduled_syncs(text, jsonb)', 'EXECUTE') auth_enq,
        has_function_privilege('authenticated', 'public.expire_stale_sync_runs()', 'EXECUTE') auth_exp,
        has_function_privilege('service_role', 'public.enqueue_scheduled_syncs(text, jsonb)', 'EXECUTE') svc_enq`);
    assertEquals([p.anon_enq, p.auth_enq, p.auth_exp, p.svc_enq], [false, false, false, true]);
  });

  await t.step("expire_stale_sync_runs closes only stale running rows", async () => {
    await w.rows("insert into integrations_syncrun (workspace_id, brand_id, integration_id, status, resource, started_at) values ($1,$2,$3,'running','payments', now() - interval '1 hour')", [A.workspace_id, A.brand_id, rzp]);
    const [r] = await w.rows<any>("select public.expire_stale_sync_runs() n");
    assertEquals(r.n, 1);
    assertEquals(await w.count("integrations_syncrun", "status='running'"), 0);
  });

  await w.close();
}});
