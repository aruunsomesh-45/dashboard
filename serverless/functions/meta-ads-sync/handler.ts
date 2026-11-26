import { successResponse } from "../_shared/response.ts";
import { logger } from "../_shared/logger.ts";
import { authorizeSyncScope, requireSyncCaller } from "../_shared/auth.ts";
import { clampInt, HttpError, readJsonObject, requireUuid } from "../_shared/http.ts";
import { fetchWithRetry, safeJson } from "../_shared/upstream.ts";
import { wrapHandler } from "../_shared/handler.ts";
import type { Deps } from "../_shared/deps.ts";
import { finishSyncRun, loadIntegration, newCounts, setIntegrationStatus, startSyncRun } from "../_shared/integrations.ts";
import { classifyMetaError, mapMetaInsightDay, normalizeMetaAdAccountId } from "../_shared/mappers.ts";

export const META_GRAPH_VERSION = "v21.0";
const GRAPH_HOST = "graph.facebook.com";

export function createHandler(deps: Deps) {
  return wrapHandler("meta-ads-sync", async (req) => {
    const caller = await requireSyncCaller(req, deps);
    const body = await readJsonObject(req);
    const workspaceId = requireUuid(body.workspace_id, "workspace_id");
    const brandId = requireUuid(body.brand_id, "brand_id");
    const days = clampInt(body.days, 30, 1, 365);
    const maxPages = clampInt(body.max_pages, 10, 1, 50);

    await authorizeSyncScope(caller, workspaceId, brandId, "meta_ads");

    const admin = deps.adminClient();
    const integ = await loadIntegration(admin, workspaceId, brandId, "meta_ads");
    const adAccountId = normalizeMetaAdAccountId(integ.credentials.ad_account_id || integ.account_identifier);
    const token = String(integ.credentials.access_token || "").trim();
    if (!adAccountId || !token) throw new HttpError(400, "Meta Ads ad_account_id and access_token are required.");

    const ctx = { workspace_id: workspaceId, brand_id: brandId };
    const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
    const until = new Date().toISOString().slice(0, 10);
    const params = new URLSearchParams({
      level: "account",
      time_increment: "1",
      time_range: JSON.stringify({ since, until }),
      fields: "date_start,spend,impressions,clicks,actions,action_values",
      limit: "100",
      access_token: token,
    });
    let nextUrl: string | null = `https://${GRAPH_HOST}/${META_GRAPH_VERSION}/${adAccountId}/insights?${params}`;

    // Existing days in range, to report created vs updated honestly.
    const { data: existingRows, error: exErr } = await admin
      .from("analytics_factadsdaily")
      .select("fact_date")
      .eq("brand_id", brandId)
      .gte("fact_date", since);
    if (exErr) throw new Error(`analytics_factadsdaily read failed: ${exErr.message}`);
    const existing = new Set((existingRows ?? []).map((r: { fact_date: string }) => String(r.fact_date).slice(0, 10)));

    const runId = await startSyncRun(admin, integ, "ads_insights", caller.kind === "cron" ? "cron" : "manual");
    const counts = newCounts();
    let pages = 0;

    try {
      while (nextUrl && pages < maxPages) {
        pages++;
        const res = await fetchWithRetry(deps.fetch, nextUrl, { headers: { Accept: "application/json" } }, { sleep: deps.sleep });
        const json = await safeJson(res);

        if (!res.ok || json?.error) {
          const err = classifyMetaError(json);
          if (err.kind === "token_invalid") {
            await setIntegrationStatus(admin, integ.id, "error", `Meta access token is invalid or expired: ${err.message}`);
          } else if (err.kind === "permission") {
            await setIntegrationStatus(admin, integ.id, "error", `Meta token lacks ads_read permission for ${adAccountId}: ${err.message}`);
          }
          throw new HttpError(502, `Meta Graph API error (${err.kind}): ${err.message}`, {
            upstream_status: res.status,
            meta_error_kind: err.kind,
            meta_error_code: err.code ?? null,
          });
        }
        if (!json || !Array.isArray(json.data)) throw new HttpError(502, "Meta returned an unexpected insights payload");

        for (const item of json.data) {
          counts.processed++;
          try {
            const row = mapMetaInsightDay(item, ctx);
            const { error } = await admin.from("analytics_factadsdaily").upsert(row, { onConflict: "brand_id,fact_date" });
            if (error) throw new Error(error.message);
            if (existing.has(row.fact_date)) counts.updated++;
            else {
              counts.created++;
              existing.add(row.fact_date);
            }
          } catch (e) {
            counts.failed++;
            logger.warn("Meta insights day not persisted", { date: String(item?.date_start ?? ""), error: (e as Error).message });
          }
        }

        // Follow cursor pagination, but only on the Graph host (never send the token elsewhere).
        const next = json.paging?.next;
        nextUrl = null;
        if (typeof next === "string") {
          try {
            const u = new URL(next);
            if (u.protocol === "https:" && u.host === GRAPH_HOST) nextUrl = u.toString();
          } catch { /* ignore malformed cursor */ }
        }
      }
    } catch (e) {
      await finishSyncRun(admin, runId, "failed", counts, (e as Error).message);
      throw e;
    }

    const ok = counts.processed - counts.failed;
    const status = counts.failed === 0 ? "success" : ok > 0 ? "partial" : "failed";
    await finishSyncRun(admin, runId, status, counts, counts.failed ? `${counts.failed} day(s) failed to persist` : "");
    await setIntegrationStatus(admin, integ.id, status === "failed" ? "error" : "connected", status === "failed" ? "No Meta insights could be saved" : "");
    if (status === "failed") throw new HttpError(500, "Meta insights were fetched but none could be saved", { ...counts, sync_run_id: runId });

    return successResponse({
      message: `Meta Ads sync ${status}: ${counts.created} day(s) created, ${counts.updated} updated, ${counts.failed} failed.`,
      status,
      sync_run_id: runId,
      records_processed: counts.processed,
      records_created: counts.created,
      records_updated: counts.updated,
      records_failed: counts.failed,
      pages_fetched: pages,
      has_more: Boolean(nextUrl),
      last_synced_at: new Date().toISOString(),
    });
  });
}
