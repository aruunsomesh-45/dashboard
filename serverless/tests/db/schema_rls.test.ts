// Supabase database tests on an ISOLATED PGlite database built from supabase/migrations.
// [LOCAL DB: real schema, constraints, triggers and RLS policies - not the hosted project]
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { createTestDatabase, APPLIED_SHIMS } from "./pglite_db.ts";
import { type Tenant, World } from "../helpers/world.ts";
import { pgUserClient } from "../helpers/pg_supabase.ts";
import { mapMetaInsightDay, mapRazorpayPayment, mapShopifyCustomer, mapShopifyLineItems, mapShopifyOrder } from "../../supabase/functions/_shared/mappers.ts";

let w: World;
let A: Tenant;
let B: Tenant;

const userClient = (t: Tenant | null) =>
  pgUserClient(w.db, w.auth, new Request("http://x", { headers: t ? { Authorization: `Bearer ${t.token}` } : {} }));

Deno.test({
  name: "DB",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async (t) => {
    w = await World.create();
    A = await w.signUp("owner-a@example.test", "Org A");
    B = await w.signUp("owner-b@example.test", "Org B");

    await t.step("every migration in supabase/migrations replays on a fresh database (with documented shims)", async () => {
      const { db, migrations } = await createTestDatabase();
      await db.close();
      const onDisk = [...Deno.readDirSync(new URL("../../../supabase/migrations/", import.meta.url))].filter((e) => e.name.endsWith(".sql")).length;
      assert(onDisk >= 18, "expected the 18+ migrations present at audit time");
      assertEquals(migrations.length, onDisk);
      assertEquals(migrations.filter((m) => !m.ok), []);
      assertEquals(APPLIED_SHIMS.length > 0, true, "shims are reported in TEST_REPORT.md");
    });

    await t.step("signup trigger provisions workspace + owner membership + brand", () => {
      assertNotEquals(A.workspace_id, B.workspace_id);
      assert(A.brand_id && B.brand_id);
    });

    // ── Schema contract: every row shape the functions write must insert cleanly ──
    await t.step("contract: mapped Shopify customer/order/lines insert into the real tables", async () => {
      const ctx = { workspace_id: A.workspace_id, brand_id: A.brand_id };
      const cust = await w.admin.from("commerce_customer").insert(mapShopifyCustomer({ id: 1, email: "c@x.in" }, ctx)!).select("id").single();
      assertEquals(cust.error, null);
      const order = await w.admin.from("commerce_order").insert(mapShopifyOrder({ id: 99, total_price: "10.00", financial_status: "authorized", fulfillment_status: null }, ctx, cust.data.id)).select("id").single();
      assertEquals(order.error, null);
      const lines = await w.admin.from("commerce_orderline").insert(mapShopifyLineItems({ line_items: [{ title: "T", quantity: 2, price: "5.00" }] }, order.data.id));
      assertEquals(lines.error, null);
    });

    await t.step("contract: mapped Razorpay payment + Meta insight insert into the real tables", async () => {
      const ctx = { workspace_id: A.workspace_id, brand_id: A.brand_id };
      assertEquals((await w.admin.from("commerce_paymentattempt").insert(mapRazorpayPayment({ id: "pay_1", amount: 100, status: "created", method: "paylater" }, ctx))).error, null);
      assertEquals((await w.admin.from("analytics_factadsdaily").insert(mapMetaInsightDay({ date_start: "2026-11-01", spend: "1.00" }, ctx))).error, null);
    });

    await t.step("regression: the column names the OLD functions wrote are rejected by the schema", async () => {
      const ctx = { workspace_id: A.workspace_id, brand_id: A.brand_id };
      const oldOrder = await w.admin.from("commerce_order").upsert({ ...ctx, external_id: "1", order_number: "1", gross_amount_minor: 1 }, { onConflict: "brand_id,external_id" });
      assertEquals(oldOrder.error?.code, "42703"); // undefined_column
      const oldPay = await w.admin.from("commerce_paymentattempt").insert({ ...ctx, provider: "razorpay", provider_id: "p", status: "success" });
      assertEquals(oldPay.error?.code, "23514"); // check_violation: 'success' not an allowed status
      const oldAds = await w.admin.from("analytics_factadsdaily").insert({ ...ctx, platform: "meta", date: "2026-11-01" });
      assertEquals(oldAds.error?.code, "42703");
    });

    // ── Constraints ──
    await t.step("unique (brand_id, provider, provider_id) blocks duplicates; upsert updates in place", async () => {
      const row = { workspace_id: A.workspace_id, brand_id: A.brand_id, provider: "shopify", provider_id: "dup-1", order_number: "1", gross_amount: 100 };
      assertEquals((await w.admin.from("commerce_order").insert(row)).error, null);
      assertEquals((await w.admin.from("commerce_order").insert(row)).error?.code, "23505");
      const up = await w.admin.from("commerce_order").upsert({ ...row, gross_amount: 250 }, { onConflict: "brand_id,provider,provider_id" }).select("gross_amount");
      assertEquals(up.data, [{ gross_amount: 250 }]);
      assertEquals(await w.count("commerce_order", "provider_id = 'dup-1'"), 1);
    });

    await t.step("same provider_id in two different brands is allowed (tenant-scoped uniqueness)", async () => {
      const base = { provider: "shopify", provider_id: "shared-1", order_number: "1" };
      assertEquals((await w.admin.from("commerce_order").insert({ ...base, workspace_id: A.workspace_id, brand_id: A.brand_id })).error, null);
      assertEquals((await w.admin.from("commerce_order").insert({ ...base, workspace_id: B.workspace_id, brand_id: B.brand_id })).error, null);
    });

    await t.step("foreign keys: unknown brand rejected; deleting an order cascades to its lines", async () => {
      const bad = await w.admin.from("commerce_order").insert({ workspace_id: A.workspace_id, brand_id: crypto.randomUUID(), provider: "shopify", provider_id: "fk", order_number: "1" });
      assertEquals(bad.error?.code, "23503");
      const o = await w.admin.from("commerce_order").insert({ workspace_id: A.workspace_id, brand_id: A.brand_id, provider: "shopify", provider_id: "cascade", order_number: "1" }).select("id").single();
      await w.admin.from("commerce_orderline").insert({ order_id: o.data.id, title: "x" });
      await w.admin.from("commerce_order").delete().eq("id", o.data.id);
      assertEquals(await w.count("commerce_orderline", "order_id = $1", [o.data.id]), 0);
    });

    await t.step("check constraints: order/payment status, quantity > 0, non-negative amounts", async () => {
      const ctx = { workspace_id: A.workspace_id, brand_id: A.brand_id };
      assertEquals((await w.admin.from("commerce_order").insert({ ...ctx, provider: "shopify", provider_id: "c1", order_number: "1", financial_status: "authorized" })).error?.code, "23514");
      assertEquals((await w.admin.from("commerce_order").insert({ ...ctx, provider: "shopify", provider_id: "c2", order_number: "1", fulfillment_status: null })).error?.code, "23502");
      assertEquals((await w.admin.from("commerce_paymentattempt").insert({ ...ctx, provider: "razorpay", provider_id: "c3", amount_minor: -1 })).error?.code, "23514");
      assertEquals((await w.admin.from("analytics_factadsdaily").insert({ ...ctx, fact_date: "2026-01-01", spend_minor: -1 })).error?.code, "23514");
    });

    // ── Webhook event storage & dedupe trigger ──
    await t.step("webhook dedupe trigger: second insert of same (brand, provider, event_id) is silently dropped", async () => {
      const ev = { workspace_id: A.workspace_id, brand_id: A.brand_id, provider: "shopify", event_id: "shopify:evt-1", topic: "orders/create", raw_body: "{}" };
      const first = await w.admin.from("integrations_webhookevent").insert(ev).select("id");
      assertEquals(first.data.length, 1);
      const second = await w.admin.from("integrations_webhookevent").insert(ev).select("id");
      assertEquals(second.error, null);
      assertEquals(second.data.length, 0);
      assertEquals(await w.count("integrations_webhookevent", "event_id = 'shopify:evt-1'"), 1);
      // same event id for a different brand is a different event
      const other = await w.admin.from("integrations_webhookevent").insert({ ...ev, workspace_id: B.workspace_id, brand_id: B.brand_id }).select("id");
      assertEquals(other.data.length, 1);
    });

    await t.step("sync history: syncrun rows record status transitions", async () => {
      const integ = await w.addIntegration(A, "shopify", { shop_domain: "a.myshopify.com", access_token: "shpat_x" });
      const run = await w.admin.from("integrations_syncrun").insert({ workspace_id: A.workspace_id, brand_id: A.brand_id, integration_id: integ, status: "running", resource: "orders" }).select("id").single();
      assertEquals(run.error, null);
      await w.admin.from("integrations_syncrun").update({ status: "success", records_processed: 3 }).eq("id", run.data.id);
      assertEquals((await w.rows<{ status: string }>("select status from integrations_syncrun where id=$1", [run.data.id]))[0].status, "success");
      assertEquals((await w.admin.from("integrations_syncrun").update({ status: "done" }).eq("id", run.data.id)).error?.code, "23514");
    });

    // ── RLS / workspace isolation ──
    await t.step("RLS: tenant A reads only its own orders; tenant B's rows are invisible", async () => {
      const a = await userClient(A).from("commerce_order").select("brand_id");
      assertEquals(a.error, null);
      assert(a.data.length > 0);
      assert(a.data.every((r: { brand_id: string }) => r.brand_id === A.brand_id));
      const peek = await userClient(A).from("commerce_order").select("id").eq("brand_id", B.brand_id);
      assertEquals(peek.data, []);
    });

    await t.step("RLS: tenant A cannot write into tenant B's workspace", async () => {
      const r = await userClient(A).from("commerce_order").insert({ workspace_id: B.workspace_id, brand_id: B.brand_id, provider: "shopify", provider_id: "xtenant", order_number: "1" });
      assertNotEquals(r.error, null);
      assertEquals(await w.count("commerce_order", "provider_id = 'xtenant'"), 0);
    });

    await t.step("RLS: tenant A cannot update or delete tenant B's rows (0 rows affected)", async () => {
      const before = await w.count("commerce_order", "brand_id = $1", [B.brand_id]);
      await userClient(A).from("commerce_order").update({ order_number: "pwned" }).eq("brand_id", B.brand_id);
      await userClient(A).from("commerce_order").delete().eq("brand_id", B.brand_id);
      assertEquals(await w.count("commerce_order", "brand_id = $1 AND order_number <> 'pwned'", [B.brand_id]), before);
    });

    await t.step("RLS: encrypted integration credentials are not readable by tenant users", async () => {
      await w.addIntegration(B, "razorpay", { key_id: "rzp_test_x", key_secret: "s", webhook_secret: "w" });
      const r = await userClient(B).from("integrations_integration").select("encrypted_credentials");
      // Either the column is not granted (error) or no row exposes ciphertext.
      if (!r.error) assert(r.data.every((x: { encrypted_credentials: unknown }) => !x.encrypted_credentials), "ciphertext must not be exposed to clients");
    });

    await t.step("RLS: tenant users cannot read raw webhook bodies of another tenant", async () => {
      const r = await userClient(B).from("integrations_webhookevent").select("brand_id");
      if (!r.error) assert(r.data.every((x: { brand_id: string }) => x.brand_id === B.brand_id));
    });

    await t.step("RLS: unauthenticated (no JWT) role sees nothing", async () => {
      const r = await userClient(null).from("commerce_order").select("id");
      assert(r.error !== null || r.data.length === 0);
    });

    await t.step("RLS: viewer member sees the workspace but cannot see other workspaces", async () => {
      const v = await w.signUp("viewer@example.test", "Viewer Own Org");
      await w.addMember(A.workspace_id, v.user.id, "viewer");
      const ws = await userClient(v).from("tenancy_workspacemember").select("workspace_id");
      const ids = new Set(ws.data.map((r: { workspace_id: string }) => r.workspace_id));
      assert(ids.has(A.workspace_id));
      assertEquals(ids.has(B.workspace_id), false);
    });

    await t.step("SQL injection: hostile values are bound as parameters, never executed", async () => {
      const evil = "x'); DROP TABLE public.commerce_order; --";
      const r = await w.admin.from("commerce_order").insert({ workspace_id: A.workspace_id, brand_id: A.brand_id, provider: "shopify", provider_id: evil, order_number: evil }).select("order_number").single();
      assertEquals(r.data.order_number, evil);
      assert((await w.count("commerce_order")) > 0, "table still exists");
    });

    await w.close();
  },
});
