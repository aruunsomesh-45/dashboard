import { successResponse } from "../_shared/response.ts";
import { logger } from "../_shared/logger.ts";
import { requireSyncCaller, requireWorkspaceAccess } from "../_shared/auth.ts";
import { clampInt, readJsonObject, requireUuid } from "../_shared/http.ts";
import { wrapHandler } from "../_shared/handler.ts";
import type { Deps } from "../_shared/deps.ts";
import { markRaw, type RawRef } from "../_shared/ingest.ts";
import {
  type ProcessOpts,
  processRazorpayPayment,
  processRazorpayRefund,
  processShopifyOrder,
  processShopifyRefund,
} from "../_shared/pipeline.ts";
import type { TenantCtx } from "../_shared/mappers.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.48.1";

type Processor = (admin: SupabaseClient, ctx: TenantCtx, payload: any, opts: ProcessOpts) => Promise<unknown>;

const PROCESSORS: Record<string, Processor> = {
  "shopify/order": processShopifyOrder,
  "shopify/refund": processShopifyRefund,
  "razorpay/payment": processRazorpayPayment,
  "razorpay/refund": processRazorpayRefund,
};

/**
 * Re-runs normalisation for raw payloads that previously failed (oldest first), then refreshes
 * reconciliation and data-quality results for the brand. Idempotent: processing is upsert-based,
 * so re-processing a payload twice cannot duplicate records.
 * Callers: Supabase Cron (x-cron-secret) or a workspace owner/admin.
 */
export function createHandler(deps: Deps) {
  return wrapHandler("reprocess-raw", async (req) => {
    const caller = await requireSyncCaller(req, deps);
    const body = await readJsonObject(req);
    const workspaceId = requireUuid(body.workspace_id, "workspace_id");
    const brandId = requireUuid(body.brand_id, "brand_id");
    const limit = clampInt(body.limit, 50, 1, 200);
    if (caller.kind === "user") {
      await requireWorkspaceAccess(caller.client, caller.user.id, workspaceId, brandId, ["owner", "admin"]);
    }

    const admin = deps.adminClient();
    const ctx = { workspace_id: workspaceId, brand_id: brandId };
    const { data: rows, error } = await admin
      .from("integrations_rawpayload")
      .select("id, created_at, provider, topic, entity_id, payload, pii_redacted, attempts")
      .eq("workspace_id", workspaceId)
      .eq("brand_id", brandId)
      .eq("processing_status", "failed")
      .order("created_at", { ascending: true })
      .limit(limit);
    if (error) throw new Error(`raw payload lookup failed: ${error.message}`);

    const result = { selected: rows?.length ?? 0, reprocessed: 0, still_failed: 0, skipped: 0 };
    for (const row of rows ?? []) {
      const ref: RawRef = { id: row.id, created_at: new Date(row.created_at).toISOString(), duplicate: true, processing_status: "failed" };
      const processor = PROCESSORS[`${row.provider}/${row.topic}`];
      if (!processor) {
        await markRaw(admin, ref, "skipped", `no processor for ${row.provider}/${row.topic}`);
        result.skipped++;
        continue;
      }
      try {
        await processor(admin, ctx, row.payload, { source: "reprocess", rawRef: ref, redacted: Boolean(row.pii_redacted) });
        result.reprocessed++;
      } catch (e) {
        result.still_failed++;
        logger.warn("Raw payload still failing", { raw_id: row.id, provider: row.provider, topic: row.topic, error: (e as Error).message });
      }
    }

    const { data: reconciliation, error: recErr } = await admin.rpc("reconcile_brand", { p_brand_id: brandId });
    if (recErr) logger.warn("reconcile_brand failed", { error: recErr.message });
    const { data: quality, error: dqErr } = await admin.rpc("run_data_quality_checks", { p_brand_id: brandId });
    if (dqErr) logger.warn("run_data_quality_checks failed", { error: dqErr.message });

    return successResponse({ ...result, reconciliation: reconciliation ?? null, data_quality: quality ?? null });
  });
}
