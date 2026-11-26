import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.48.1";
import { canonicalJson, redactPii } from "./pii.ts";
import { sha256Hex } from "./signatures.ts";
import { logger } from "./logger.ts";
import type { TenantCtx } from "./mappers.ts";

export type RawSource = "sync" | "webhook" | "backfill" | "reprocess";

/** Pointer to one row of the partitioned integrations_rawpayload table. */
export interface RawRef {
  id: string;
  created_at: string;
  duplicate: boolean;
  processing_status: string;
}

/**
 * Stores the source payload (PII-minimised) before normalisation. The hash is taken over the
 * ORIGINAL payload, so an unchanged re-fetch is recognised and not stored twice.
 * Best-effort: a storage failure is logged and returns null; it never blocks normalisation.
 */
export async function recordRaw(
  admin: SupabaseClient,
  ctx: TenantCtx,
  e: { provider: string; topic: string; entityId: string; payload: unknown; source: RawSource },
): Promise<RawRef | null> {
  try {
    const hash = await sha256Hex(new TextEncoder().encode(canonicalJson(e.payload)));
    const { data, error } = await admin.rpc("ingest_raw_payload", {
      p_workspace_id: ctx.workspace_id,
      p_brand_id: ctx.brand_id,
      p_provider: e.provider,
      p_topic: e.topic,
      p_entity_id: e.entityId,
      p_payload: redactPii(e.payload),
      p_payload_hash: hash,
      p_source: e.source,
      p_pii_redacted: true,
    });
    if (error) throw new Error(error.message);
    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.id) return null;
    return { id: row.id, created_at: new Date(row.created_at).toISOString(), duplicate: Boolean(row.duplicate), processing_status: row.processing_status };
  } catch (err) {
    logger.warn("Raw payload not stored", { provider: e.provider, topic: e.topic, entity_id: e.entityId, error: (err as Error).message });
    return null;
  }
}

/** Records the normalisation outcome; failed rows stay queryable and can be re-processed. */
export async function markRaw(admin: SupabaseClient, ref: RawRef | null, status: "processed" | "failed" | "skipped", error = ""): Promise<void> {
  if (!ref) return;
  const { error: err } = await admin.rpc("mark_raw_payload", {
    p_id: ref.id,
    p_created_at: ref.created_at,
    p_status: status,
    p_error: error,
  });
  if (err) logger.warn("Raw payload status not updated", { raw_id: ref.id, error: err.message });
}
