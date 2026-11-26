// Verifies the fixes made before deployment, through the REAL route handlers:
//  - invites respect the plan's member limit (members + pending invites)
//  - the Logistics "Sync shipments" request forwards the typed waybills to delhivery-sync
//  - a plain sync request (no waybills) is still forwarded without a waybill list
// [LOCAL PGlite DB + real route code + scripted Delhivery API]
import { assert, assertEquals } from "jsr:@std/assert@1";
import { hit, WebWorld } from "./harness.ts";
import { json } from "../helpers/world.ts";

const opts = { sanitizeResources: false, sanitizeOps: false };

Deno.test({ ...opts, name: "Pre-deployment fixes", fn: async (t) => {
  const ww = await WebWorld.create();
  const w = ww.w;
  const api = await import("../../../frontend/src/app/api/[[...path]]/route.ts");
  const T = await ww.tenant("fix-owner@example.test", "Fix Org");   // starter plan: max 3 members
  const cookies = { "sb-access-token": T.token };
  const ws = `/api/w/${T.slug}`;

  await t.step("invites: starter plan allows 3 members in total, pending invites hold a seat; the one beyond that is refused", async () => {
    const r1 = await hit(api, `${ws}/invites/`, { method: "POST", cookies, body: { email: "one@example.test", role: "analyst" } });
    assertEquals(r1.status, 200, JSON.stringify(r1.body));   // 1 member + 0 pending = 1 < 3
    const r2 = await hit(api, `${ws}/invites/`, { method: "POST", cookies, body: { email: "two@example.test", role: "viewer" } });
    assertEquals(r2.status, 200, JSON.stringify(r2.body));   // 1 member + 1 pending = 2 < 3
    const r3 = await hit(api, `${ws}/invites/`, { method: "POST", cookies, body: { email: "three@example.test", role: "viewer" } });
    assertEquals(r3.status, 409, JSON.stringify(r3.body));   // 1 member + 2 pending = 3 >= 3: refused
    assert(String(r3.body.error).includes("allows 3 members"), r3.body.error);
    assertEquals(await w.count("tenancy_invite", "workspace_id=$1", [T.workspace_id]), 2);
  });

  await t.step("invites: an expired invite no longer holds a seat", async () => {
    await w.db.query("update tenancy_invite set expires_at = now() - interval '1 day' where workspace_id=$1 and email='two@example.test'", [T.workspace_id]);
    const r = await hit(api, `${ws}/invites/`, { method: "POST", cookies, body: { email: "three@example.test", role: "viewer" } });
    assertEquals(r.status, 200, JSON.stringify(r.body));   // 1 member + 1 pending = 2 < 3
  });

  await t.step("logistics sync with typed waybills: request is forwarded with the awbs list and shipments are stored", async () => {
    await w.addIntegration(T, "delhivery", { api_token: "dlv_fix_token" }, "DLH_FIX");
    w.http.routes = [];
    w.http.on(/track\.delhivery\.com\/api\/v1\/packages\/json\//, () => json({
      ShipmentData: [{ Shipment: { AWB: "FIXAWB1", ReferenceNo: "", Status: { Status: "In Transit", StatusType: "UD", StatusDateTime: "2026-11-25T10:00:00" }, Scans: [] } }],
    }));
    const before = ww.edgeCalls?.length ?? 0;
    const r = await hit(api, `/api/w/${T.slug}/b/${T.brand_id}/logistics/sync-now`, { method: "POST", cookies, body: { awbs: ["FIXAWB1"] } });
    assertEquals(r.status, 200, JSON.stringify(r.body));
    const call = ww.edgeCalls.slice(before).find((c) => c.fn === "delhivery-sync");
    assert(call, "delhivery-sync was not called");
    assertEquals(call!.body.awbs, ["FIXAWB1"]);
    assertEquals(call!.body.workspace_id, T.workspace_id);
    assertEquals(await w.count("commerce_shipment", "awb='FIXAWB1' and brand_id=$1", [T.brand_id]), 1);
  });

  await t.step("plain sync (no body, e.g. the Sync button of another app) is forwarded without a waybill list", async () => {
    const before = ww.edgeCalls.length;
    const r = await hit(api, `/api/w/${T.slug}/b/${T.brand_id}/logistics/sync-now`, { method: "POST", cookies, body: {} });
    assertEquals(r.status, 200, JSON.stringify(r.body));
    const call = ww.edgeCalls.slice(before).find((c) => c.fn === "delhivery-sync");
    assert(call, "delhivery-sync was not called");
    assert(!("awbs" in call!.body), "no waybill list should be sent when none was typed");
  });
}});
