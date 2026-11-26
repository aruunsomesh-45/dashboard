// Delhivery sync end-to-end: auth -> credential decrypt -> scripted Delhivery tracking API -> shipment
// upsert -> order link -> sync history. [MOCKED Delhivery API (synthetic payloads) + LOCAL DB (real schema)]
// These prove the code path and persistence logic. They do NOT prove the response shape matches live
// Delhivery: that needs one real staging call (see the note in mappers.ts).
import { assertEquals, assert } from "jsr:@std/assert@1";
import { call, json, type Tenant, World } from "../helpers/world.ts";
import { createHandler as delhiverySync } from "../../supabase/functions/delhivery-sync/handler.ts";

const opts = { sanitizeResources: false, sanitizeOps: false };
const TRACK = /track\.delhivery\.com\/api\/v1\/packages\/json\//;

async function freshWorld() {
  const w = await World.create();
  const A = await w.signUp("owner-a@example.test", "Org A");
  const C = await w.signUp("owner-c@example.test", "Org C");
  return { w, A, C };
}
const body = (t: Tenant, extra: Record<string, unknown> = {}) => ({ workspace_id: t.workspace_id, brand_id: t.brand_id, ...extra });

/** A Delhivery tracking entry (pull API). Times without offset are IST per the mapper. */
const entry = (awb: string, statusType: string, status: string, ref: string) => ({
  Shipment: {
    AWB: awb,
    ReferenceNo: ref,
    PickUpDate: "2026-11-18T10:00:00",
    Status: { Status: status, StatusType: statusType, StatusDateTime: "2026-11-20T14:30:00" },
    Scans: [],
  },
});

Deno.test({ ...opts, name: "Delhivery sync", fn: async (t) => {
  const { w, A, C } = await freshWorld();
  const integ = await w.addIntegration(A, "delhivery", { api_token: "dlv_synthetic_token", client_id: "DLH_TEST" }, "DLH_TEST");
  // Shopify order the Delhivery shipment refers to (order number 1001, stored as "1001").
  await w.db.query(
    `INSERT INTO public.commerce_order (workspace_id, brand_id, provider, provider_id, order_number, gross_amount, net_sales, financial_status, fulfillment_status, source_created_at)
     VALUES ($1,$2,'shopify','9001','1001',118000,100000,'paid','fulfilled', now())`,
    [A.workspace_id, A.brand_id]);
  const h = () => delhiverySync(w.deps());

  await t.step("non-member caller -> 403 and Delhivery is never called", async () => {
    const before = w.http.calls.length;
    const r = await call(h(), "delhivery-sync", { token: C.token, body: body(A, { awbs: ["AWB1"] }) });
    assertEquals(r.status, 403);
    assertEquals(w.http.calls.length, before);
  });

  await t.step("invalid awbs input -> 400 before any network call", async () => {
    const before = w.http.calls.length;
    assertEquals((await call(h(), "delhivery-sync", { token: A.token, body: body(A, { awbs: "AWB1" }) })).status, 400);
    assertEquals((await call(h(), "delhivery-sync", { token: A.token, body: body(A, { awbs: ["AWB 1;DROP"] }) })).status, 400);
    assertEquals(w.http.calls.length, before);
  });

  await t.step("token rejected (401) -> 502, integration marked error, nothing stored", async () => {
    w.http.routes = [];
    w.http.on(TRACK, () => new Response("Unauthorized", { status: 401 }));
    const r = await call(h(), "delhivery-sync", { token: A.token, body: body(A, { awbs: ["AWB1"] }) });
    assertEquals(r.status, 502);
    assertEquals(w.http.calls.at(-1)?.headers.get("Authorization"), "Token dlv_synthetic_token");
    const [row] = await w.rows<any>("select status from integrations_integration where id=$1", [integ]);
    assertEquals(row.status, "error");
    assertEquals(await w.count("commerce_shipment", "brand_id=$1", [A.brand_id]), 0);
  });

  await t.step("explicit AWBs: stores shipments, links the order by reference, counts unknown waybills", async () => {
    w.http.routes = [];
    w.http.on(TRACK, () => json({
      ShipmentData: [
        entry("AWB1", "DL", "Delivered", "1001"),
        entry("AWB2", "UD", "In Transit", "1002"),
        {}, // Delhivery returns an entry without an AWB for a waybill it does not know
      ],
    }));
    const r = await call(h(), "delhivery-sync", { token: A.token, body: body(A, { awbs: ["AWB1", "AWB2", "AWB9"] }) });
    assertEquals(r.status, 200, JSON.stringify(r.body));
    assertEquals(r.body.data.status, "success");
    assertEquals(r.body.data.records_created, 2);
    assertEquals(r.body.data.records_updated, 0);
    assertEquals(r.body.data.orders_linked, 1);
    assertEquals(r.body.data.records_not_found, 2); // the empty entry is counted; AWB9 is not in ShipmentData
    const url = w.http.calls.at(-1)!.url;
    assert(url.includes("waybill=AWB1,AWB2,AWB9"), url);
    assertEquals(w.http.calls.at(-1)!.headers.get("Authorization"), "Token dlv_synthetic_token");

    assertEquals(await w.count("commerce_shipment", "brand_id=$1 AND provider='delhivery'", [A.brand_id]), 2);
    const [s1] = await w.rows<any>("select canonical_status, courier_name, delivered_at from commerce_shipment where awb='AWB1'");
    assertEquals(s1.canonical_status, "delivered");
    assertEquals(s1.courier_name, "Delhivery");
    assert(s1.delivered_at);
    const [s2] = await w.rows<any>("select canonical_status, shipped_at from commerce_shipment where awb='AWB2'");
    assertEquals(s2.canonical_status, "in_transit");
    const links = await w.rows<any>(
      `select l.match_method, o.order_number from commerce_ordershipmentlink l join commerce_order o on o.id=l.order_id`);
    assertEquals(links.length, 1);
    assertEquals([links[0].match_method, links[0].order_number], ["delhivery_reference", "1001"]);

    const [run] = await w.rows<any>("select status, records_processed, records_created from integrations_syncrun where integration_id=$1 and resource='shipments'", [integ]);
    assertEquals([run.status, run.records_processed, run.records_created], ["success", 2, 2]);
    const [st] = await w.rows<any>("select status from integrations_integration where id=$1", [integ]);
    assertEquals(st.status, "connected");
  });

  await t.step("re-sync is idempotent: updates, no duplicate shipments or links", async () => {
    w.http.routes = [];
    w.http.on(TRACK, () => json({ ShipmentData: [entry("AWB1", "DL", "Delivered", "1001"), entry("AWB2", "DL", "Delivered", "1002")] }));
    const r = await call(h(), "delhivery-sync", { token: A.token, body: body(A, { awbs: ["AWB1", "AWB2"] }) });
    assertEquals(r.status, 200);
    assertEquals(r.body.data.records_created, 0);
    assertEquals(r.body.data.records_updated, 2);
    assertEquals(await w.count("commerce_shipment", "brand_id=$1", [A.brand_id]), 2);
    assertEquals(await w.count("commerce_ordershipmentlink"), 1);
    const [s2] = await w.rows<any>("select canonical_status from commerce_shipment where awb='AWB2'");
    assertEquals(s2.canonical_status, "delivered");
  });

  await t.step("plain sync (no awbs) refreshes only shipments not yet in a final state", async () => {
    w.http.routes = [];
    w.http.on(TRACK, () => json({ ShipmentData: [] }));
    // AWB1 and AWB2 are now delivered (final); AWB3 is open and must be the only one requested.
    await w.db.query(
      `INSERT INTO public.commerce_shipment (workspace_id, brand_id, provider, provider_id, awb, courier_name, canonical_status)
       VALUES ($1,$2,'delhivery','AWB3','AWB3','Delhivery','ndr')`, [A.workspace_id, A.brand_id]);
    const r = await call(h(), "delhivery-sync", { token: A.token, body: body(A) });
    assertEquals(r.status, 200, JSON.stringify(r.body));
    assertEquals(r.body.data.awbs_requested, 1);
    assert(w.http.calls.at(-1)!.url.endsWith("?waybill=AWB3"), w.http.calls.at(-1)!.url);
    assertEquals(r.body.data.records_not_found, 1);
  });

  await t.step("more than 30 waybills are split into batches of 30", async () => {
    w.http.routes = [];
    w.http.on(TRACK, () => json({ ShipmentData: [] }));
    const many = Array.from({ length: 31 }, (_, i) => `BATCH${String(i).padStart(3, "0")}`);
    const before = w.http.calls.length;
    const r = await call(h(), "delhivery-sync", { token: A.token, body: body(A, { awbs: many }) });
    assertEquals(r.status, 200);
    assertEquals(w.http.calls.length - before, 2);
    assertEquals(r.body.data.requests_made, 2);
    assertEquals(r.body.data.records_not_found, 31);
  });

  await t.step("integration not connected for this brand -> 404", async () => {
    const C2 = await w.signUp("owner-d@example.test", "Org D");
    const r = await call(h(), "delhivery-sync", { token: C2.token, body: body(C2, { awbs: ["AWB1"] }) });
    assertEquals(r.status, 404);
  });
}});
