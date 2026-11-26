import { successResponse } from "../_shared/response.ts";
import { logger } from "../_shared/logger.ts";
import { authorizeSyncScope, requireSyncCaller } from "../_shared/auth.ts";
import { HttpError, readJsonObject, requireUuid } from "../_shared/http.ts";
import { fetchWithRetry, safeJson } from "../_shared/upstream.ts";
import { wrapHandler } from "../_shared/handler.ts";
import type { Deps } from "../_shared/deps.ts";
import {
  finishSyncRun,
  loadIntegration,
  newCounts,
  setIntegrationStatus,
  startSyncRun,
  upsertCanonical,
} from "../_shared/integrations.ts";
import { mapDelhiveryShipment } from "../_shared/mappers.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.48.1";

/** Pull tracking API. Auth: `Authorization: Token <key>`. Up to 30 waybills per request (Delhivery FAQ). */
export const DELHIVERY_TRACK_URL = "https://track.delhivery.com/api/v1/packages/json/";
export const DELHIVERY_MAX_AWBS_PER_REQUEST = 30;
const MAX_EXPLICIT_AWBS = 300;
/** Shipments in these states are final: they are not re-polled on every sync. */
const FINAL_STATUSES = ["delivered", "rto_delivered", "cancelled"];
const AWB_RE = /^[A-Za-z0-9]{4,50}$/;

/** Optional `awbs` array from the caller. Anything that is not a plausible waybill is a 400. */
export function parseExplicitAwbs(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new HttpError(400, "awbs must be an array of waybill numbers");
  if (value.length > MAX_EXPLICIT_AWBS) throw new HttpError(400, `awbs accepts at most ${MAX_EXPLICIT_AWBS} waybills per call`);
  const out = new Set<string>();
  for (const v of value) {
    const awb = String(v ?? "").trim();
    if (!AWB_RE.test(awb)) throw new HttpError(400, `Invalid waybill number: ${awb.slice(0, 60)}`);
    out.add(awb);
  }
  return [...out];
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Waybills already stored for this brand that are not yet in a final state: what a plain sync refreshes.
 * Oldest-checked first, so a large backlog is worked through over successive runs.
 */
async function openAwbs(admin: SupabaseClient, workspaceId: string, brandId: string): Promise<string[]> {
  const { data, error } = await admin
    .from("commerce_shipment")
    .select("awb, canonical_status")
    .eq("workspace_id", workspaceId)
    .eq("brand_id", brandId)
    .eq("provider", "delhivery")
    .order("updated_at", { ascending: true })
    .limit(MAX_EXPLICIT_AWBS * 4);
  if (error) throw new Error(`Could not list open Delhivery shipments: ${error.message}`);
  const open = (data || []).filter((r: { canonical_status: string }) => !FINAL_STATUSES.includes(r.canonical_status));
  return [...new Set(open.map((r: { awb: string }) => r.awb).filter(Boolean))].slice(0, MAX_EXPLICIT_AWBS);
}

/**
 * Links a shipment to the Shopify order whose number Delhivery returns as ReferenceNo (sent as the order
 * name when the shipment was created). Matches "1001" and "#1001". Returns how many links were written.
 */
async function linkShipmentToOrder(
  admin: SupabaseClient,
  brandId: string,
  shipmentId: string,
  orderRef: string,
): Promise<number> {
  const ref = orderRef.trim();
  if (!ref) return 0;
  const { data: orders, error } = await admin
    .from("commerce_order")
    .select("id")
    .eq("brand_id", brandId)
    .in("order_number", [ref, `#${ref.replace(/^#/, "")}`])
    .limit(2);
  if (error) throw new Error(`Order lookup failed: ${error.message}`);
  // Only link when the reference is unambiguous; two orders with the same number are left unlinked.
  if (!orders || orders.length !== 1) return 0;
  const { error: linkErr } = await admin.from("commerce_ordershipmentlink").upsert(
    { order_id: orders[0].id, shipment_id: shipmentId, match_method: "delhivery_reference", confidence: 0.9 },
    { onConflict: "order_id,shipment_id", ignoreDuplicates: true },
  );
  if (linkErr) throw new Error(`Order link failed: ${linkErr.message}`);
  return 1;
}

export function createHandler(deps: Deps) {
  return wrapHandler("delhivery-sync", async (req) => {
    const caller = await requireSyncCaller(req, deps);
    const body = await readJsonObject(req);
    const workspaceId = requireUuid(body.workspace_id, "workspace_id");
    const brandId = requireUuid(body.brand_id, "brand_id");
    const explicitAwbs = parseExplicitAwbs(body.awbs);

    await authorizeSyncScope(caller, workspaceId, brandId, "delivery");

    const admin = deps.adminClient();
    const integ = await loadIntegration(admin, workspaceId, brandId, "delhivery");
    const token = String(integ.credentials.api_token || "").trim();
    if (!token) throw new HttpError(400, "Delhivery API token is missing.");

    const ctx = { workspace_id: workspaceId, brand_id: brandId };
    // Resolve the waybill list BEFORE the sync run is recorded: a failure here must not leave a run open.
    const awbs = explicitAwbs.length ? explicitAwbs : await openAwbs(admin, workspaceId, brandId);
    const runId = await startSyncRun(admin, integ, "shipments", caller.kind === "cron" ? "cron" : "manual");
    const counts = newCounts();
    let linked = 0;
    let notFound = 0;

    const batches = chunk(awbs, DELHIVERY_MAX_AWBS_PER_REQUEST);
    try {
      for (const batch of batches) {
        const url = `${DELHIVERY_TRACK_URL}?waybill=${batch.map(encodeURIComponent).join(",")}`;
        const res = await fetchWithRetry(
          deps.fetch,
          url,
          { headers: { Authorization: `Token ${token}`, Accept: "application/json" } },
          { sleep: deps.sleep },
        );
        if (res.status === 401 || res.status === 403) {
          await setIntegrationStatus(admin, integ.id, "error", `Delhivery rejected the API token (${res.status})`);
          throw new HttpError(502, `Delhivery rejected the API token (${res.status})`, { upstream_status: res.status });
        }
        if (!res.ok) throw new HttpError(502, `Delhivery API error: HTTP ${res.status}`, { upstream_status: res.status });

        const json = await safeJson(res);
        if (!json || !Array.isArray(json.ShipmentData)) {
          throw new HttpError(502, "Delhivery returned an unexpected tracking payload");
        }
        const returned = new Set<string>();

        for (const item of json.ShipmentData) {
          const shipment = item?.Shipment;
          if (!shipment?.AWB) {
            notFound++; // Delhivery returns an entry without an AWB for waybills it does not know
            continue;
          }
          returned.add(String(shipment.AWB));
          counts.processed++;
          try {
            const { shipment: row } = mapDelhiveryShipment(shipment, ctx);
            const { id, created } = await upsertCanonical(admin, "commerce_shipment", row);
            if (created) counts.created++;
            else counts.updated++;
            linked += await linkShipmentToOrder(admin, brandId, id, String(shipment.ReferenceNo ?? ""));
          } catch (e) {
            counts.failed++;
            logger.warn("Delhivery shipment not persisted", { awb: String(shipment.AWB), error: (e as Error).message });
          }
        }
        notFound += batch.filter((awb) => !returned.has(awb)).length;
      }
    } catch (e) {
      await finishSyncRun(admin, runId, "failed", counts, (e as Error).message);
      throw e;
    }

    const ok = counts.processed - counts.failed;
    const status = counts.failed === 0 ? "success" : ok > 0 ? "partial" : "failed";
    await finishSyncRun(admin, runId, status, counts, counts.failed ? `${counts.failed} shipment(s) failed to persist` : "");
    await setIntegrationStatus(
      admin,
      integ.id,
      status === "failed" ? "error" : "connected",
      status === "failed" ? "No Delhivery shipments could be saved" : "",
    );
    if (status === "failed") {
      throw new HttpError(500, "Delhivery shipments were fetched but none could be saved", { ...counts, sync_run_id: runId });
    }

    return successResponse({
      message: `Delhivery sync ${status}: ${counts.created} created, ${counts.updated} updated, ${counts.failed} failed, ${linked} linked to orders.`,
      status,
      sync_run_id: runId,
      awbs_requested: awbs.length,
      requests_made: batches.length,
      records_processed: counts.processed,
      records_created: counts.created,
      records_updated: counts.updated,
      records_failed: counts.failed,
      records_not_found: notFound,
      orders_linked: linked,
      last_synced_at: new Date().toISOString(),
    });
  });
}
