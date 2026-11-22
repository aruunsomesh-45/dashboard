// Per-user / per-workspace module permissions (migrations 20261121134000 + 20261121150000) and their
// enforcement in the sync Edge Functions.
// [MOCKED upstream APIs + LOCAL DB (real schema/RLS via PGlite) — never touches the hosted project]
//
// Regression for QA-2026-11-21 defect P0-2: requireModuleAccess() treated the JSONB object returned by
// get_user_effective_modules() as an array, so `.find` threw and EVERY non-superuser sync returned 500.
import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import { call, json, type Tenant, World } from "../helpers/world.ts";
import { pgUserClient } from "../helpers/pg_supabase.ts";
import { shopifyOrder } from "../helpers/payloads.ts";
import { createHandler as shopifySync } from "../../supabase/functions/shopify-sync/handler.ts";
import { isModuleEnabled } from "../../supabase/functions/_shared/auth.ts";

const opts = { sanitizeResources: false, sanitizeOps: false };

Deno.test("isModuleEnabled: JSONB object shape (what the RPC returns)", () => {
  assert(isModuleEnabled({ shopify: true, razorpay: false }, "shopify"));
  assertFalse(isModuleEnabled({ shopify: true, razorpay: false }, "razorpay"));
  assertFalse(isModuleEnabled({ shopify: true }, "meta_ads"), "missing key must deny");
  assertFalse(isModuleEnabled({ shopify: "true" }, "shopify"), "only boolean true grants");
});

Deno.test("isModuleEnabled: array shape and garbage fail closed", () => {
  assert(isModuleEnabled([{ module_key: "shopify", enabled: true }], "shopify"));
  assertFalse(isModuleEnabled([{ module_key: "shopify", enabled: false }], "shopify"));
  for (const bad of [null, undefined, "shopify", 1, true, [], {}, [null]]) {
    assertFalse(isModuleEnabled(bad, "shopify"), `input ${JSON.stringify(bad)} must deny`);
  }
});

Deno.test({ ...opts, name: "Module permissions (DB + Edge Function enforcement)", fn: async (t) => {
  const w = await World.create();
  const A = await w.signUp("mod-owner-a@example.test", "Org A");
  const B = await w.signUp("mod-owner-b@example.test", "Org B");
  const client = (tn: Tenant | null) =>
    pgUserClient(w.db, w.auth, new Request("http://x", { headers: tn ? { Authorization: `Bearer ${tn.token}` } : {} }));

  await w.addIntegration(A, "shopify", { shop_domain: "test-store.myshopify.com", access_token: "shpat_synthetic" });
  const sync = () =>
    call(shopifySync(w.deps()), "shopify-sync", { token: A.token, body: { workspace_id: A.workspace_id, brand_id: A.brand_id } });

  await t.step("RPC returns a JSONB object keyed by module for the caller", async () => {
    const { data, error } = await client(A).rpc("get_user_effective_modules", { p_user_id: A.user.id, p_workspace_id: A.workspace_id });
    assertEquals(error, null);
    assertEquals(typeof data, "object");
    assertFalse(Array.isArray(data));
    assertEquals(data.shopify, true);
  });

  await t.step("a user cannot read another user's module permissions", async () => {
    const { data, error } = await client(A).rpc("get_user_effective_modules", { p_user_id: B.user.id, p_workspace_id: B.workspace_id });
    assertEquals(data, null);
    assert(error, "expected an authorization error");
  });

  await t.step("authenticated clients cannot write permission rows or audit logs", async () => {
    const r1 = await client(A).from("user_module_permissions").insert({
      user_id: A.user.id, workspace_id: A.workspace_id, module_key: "shopify", enabled: true,
    });
    assert(r1.error, "insert into user_module_permissions must be refused");
    const r2 = await client(A).from("admin_audit_logs").insert({ admin_user_id: A.user.id, action: "forged" });
    assert(r2.error, "insert into admin_audit_logs must be refused");
    assertEquals(await w.count("admin_audit_logs"), 0);
  });

  await t.step("module enabled (default) -> sync runs and persists (was 500 before the fix)", async () => {
    w.http.routes = [{ match: /orders\.json/, respond: () => json({ orders: [shopifyOrder(9001)] }) }];
    w.http.calls = [];
    const r = await sync();
    assertEquals(r.status, 200, JSON.stringify(r.body));
    assertEquals(await w.count("commerce_order", "brand_id = $1", [A.brand_id]), 1);
  });

  await t.step("module disabled for the workspace -> 403 and no upstream call", async () => {
    await w.db.query(
      `INSERT INTO public.workspace_module_permissions (workspace_id, module_key, enabled) VALUES ($1, 'shopify', false)`,
      [A.workspace_id],
    );
    w.http.calls = [];
    const r = await sync();
    assertEquals(r.status, 403);
    assertEquals(w.http.calls.length, 0, "no Shopify request may be made when the module is off");
  });

  await t.step("per-user override re-enables the module for that user", async () => {
    await w.db.query(
      `INSERT INTO public.user_module_permissions (user_id, workspace_id, module_key, enabled) VALUES ($1, $2, 'shopify', true)`,
      [A.user.id, A.workspace_id],
    );
    w.http.routes = [{ match: /orders\.json/, respond: () => json({ orders: [] }) }];
    const r = await sync();
    assertEquals(r.status, 200, JSON.stringify(r.body));
  });

  await w.close();
}});
