import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.48.1";
import { decryptCredentials } from "./crypto.ts";
import { HttpError } from "./http.ts";
import { logger } from "./logger.ts";

export type Provider = "shopify" | "razorpay" | "meta_ads" | "instagram" | "delhivery";

export interface LoadedIntegration {
  id: string;
  workspace_id: string;
  brand_id: string;
  provider: Provider;
  account_identifier: string;
  credentials: Record<string, unknown>;
}

/** Loads one brand's integration (service-role client) and decrypts its credentials. */
export async function loadIntegration(
  admin: SupabaseClient,
  workspaceId: string,
  brandId: string,
  provider: Provider,
): Promise<LoadedIntegration> {
  const { data, error } = await admin
    .from("integrations_integration")
    .select("id, workspace_id, brand_id, provider, account_identifier, encrypted_credentials")
    .eq("workspace_id", workspaceId)
    .eq("brand_id", brandId)
    .eq("provider", provider)
    .maybeSingle();

  if (error) throw new Error(`Failed to load ${provider} integration: ${error.message}`);
  if (!data) throw new HttpError(404, `${provider} integration not configured for this brand`);

  let credentials: Record<string, unknown> = {};
  if (data.encrypted_credentials) {
    try {
      credentials = await decryptCredentials(data.encrypted_credentials);
    } catch (e) {
      throw new HttpError(500, `Stored ${provider} credentials could not be decrypted (check INTEGRATION_ENCRYPTION_KEY)`, {
        cause: (e as Error).message,
      });
    }
  }
  const { encrypted_credentials: _omit, ...rest } = data;
  return { ...rest, credentials } as LoadedIntegration;
}

/** Incremental-sync checkpoint (integrations_synccursor) for one integration + resource, or null. */
export async function loadCursor(admin: SupabaseClient, integ: LoadedIntegration, resource: string): Promise<string | null> {
  const { data, error } = await admin.from("integrations_synccursor").select("cursor_value")
    .eq("integration_id", integ.id).eq("resource", resource).maybeSingle();
  if (error) {
    logger.warn("Could not read sync cursor", { provider: integ.provider, error: error.message });
    return null;
  }
  return data?.cursor_value || null;
}

/**
 * Advances the checkpoint. ISO-8601 UTC strings compare chronologically, and the cursor never moves
 * backwards, so a historical backfill can't rewind an incremental sync.
 */
export async function saveCursor(admin: SupabaseClient, integ: LoadedIntegration, resource: string, value: string): Promise<boolean> {
  const current = await loadCursor(admin, integ, resource);
  if (current && current >= value) return false;
  const { error } = await admin.from("integrations_synccursor").upsert({
    workspace_id: integ.workspace_id,
    brand_id: integ.brand_id,
    integration_id: integ.id,
    resource,
    cursor_value: value,
    last_checkpoint: new Date().toISOString(),
  }, { onConflict: "integration_id,resource" });
  if (error) {
    logger.warn("Could not save sync cursor", { provider: integ.provider, error: error.message });
    return false;
  }
  return true;
}

/** Re-read this much before the checkpoint so records updated around the boundary are never missed. */
export const CURSOR_OVERLAP_MS = 10 * 60_000;

/** A run still marked `running` after this long is treated as abandoned (Edge Functions time out far sooner). */
export const STALE_RUN_MINUTES = 15;

/**
 * Records a sync attempt in integrations_syncrun (sync history) and acts as the overlap lock:
 * the partial unique index uq_syncrun_one_running (migration 20261123120000) allows only one
 * `running` row per (integration, resource), so a concurrent second run gets 409 instead of
 * double-ingesting. Abandoned runs older than STALE_RUN_MINUTES are closed first so they can't block forever.
 */
export async function startSyncRun(
  admin: SupabaseClient,
  integ: LoadedIntegration,
  resource: string,
  triggeredBy: "manual" | "cron" = "manual",
): Promise<string | null> {
  const staleBefore = new Date(Date.now() - STALE_RUN_MINUTES * 60_000).toISOString();
  const { error: staleErr } = await admin
    .from("integrations_syncrun")
    .update({
      status: "failed",
      finished_at: new Date().toISOString(),
      error_message: `Abandoned: no completion recorded within ${STALE_RUN_MINUTES} minutes`,
    })
    .eq("integration_id", integ.id)
    .eq("resource", resource)
    .eq("status", "running")
    .lt("started_at", staleBefore);
  if (staleErr) logger.warn("Could not expire stale sync runs", { provider: integ.provider, error: staleErr.message });

  const { data, error } = await admin
    .from("integrations_syncrun")
    .insert({
      workspace_id: integ.workspace_id,
      brand_id: integ.brand_id,
      integration_id: integ.id,
      status: "running",
      resource,
      triggered_by: triggeredBy,
      started_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error) {
    if ((error as { code?: string }).code === "23505") {
      throw new HttpError(409, `A ${integ.provider} sync is already running for this brand; try again shortly`);
    }
    logger.warn("Could not create sync run", { provider: integ.provider, error: error.message });
    return null;
  }
  return data.id;
}

export interface SyncCounts {
  processed: number;
  created: number;
  updated: number;
  failed: number;
}

export function newCounts(): SyncCounts {
  return { processed: 0, created: 0, updated: 0, failed: 0 };
}

export async function finishSyncRun(
  admin: SupabaseClient,
  runId: string | null,
  status: "success" | "failed" | "partial",
  counts: SyncCounts,
  errorMessage = "",
): Promise<void> {
  if (!runId) return;
  const { error } = await admin
    .from("integrations_syncrun")
    .update({
      status,
      finished_at: new Date().toISOString(),
      records_processed: counts.processed,
      records_created: counts.created,
      records_updated: counts.updated,
      error_message: errorMessage.slice(0, 2000),
    })
    .eq("id", runId);
  if (error) logger.warn("Could not finish sync run", { error: error.message });
}

/** Updates the integration's health fields after a sync / test. */
export async function setIntegrationStatus(
  admin: SupabaseClient,
  integrationId: string,
  status: "connected" | "error" | "token_expiring",
  errorMessage = "",
  extra: Record<string, unknown> = {},
): Promise<void> {
  const patch: Record<string, unknown> = { status, last_error_message: errorMessage.slice(0, 2000), ...extra };
  if (status === "connected") patch.last_synced_at = new Date().toISOString();
  const { error } = await admin.from("integrations_integration").update(patch).eq("id", integrationId);
  if (error) logger.warn("Could not update integration status", { error: error.message });
}

/**
 * Upserts one canonical row keyed by (brand_id, provider, provider_id) and reports whether it was
 * created or updated. Throws on database error: a failed write must never be counted as success.
 */
export async function upsertCanonical(
  admin: SupabaseClient,
  table: string,
  row: Record<string, unknown>,
): Promise<{ id: string; created: boolean }> {
  const { data: existing, error: lookupErr } = await admin
    .from(table)
    .select("id")
    .eq("brand_id", row.brand_id as string)
    .eq("provider", row.provider as string)
    .eq("provider_id", row.provider_id as string)
    .maybeSingle();
  if (lookupErr) throw new Error(`${table} lookup failed: ${lookupErr.message}`);

  const { data, error } = await admin
    .from(table)
    .upsert(row, { onConflict: "brand_id,provider,provider_id" })
    .select("id")
    .single();
  if (error || !data) throw new Error(`${table} upsert failed: ${error?.message ?? "no row returned"}`);
  return { id: data.id, created: !existing };
}
