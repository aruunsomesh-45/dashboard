import { successResponse } from "../_shared/response.ts";
import { logger } from "../_shared/logger.ts";
import { authorizeSyncScope, requireSyncCaller } from "../_shared/auth.ts";
import { clampInt, HttpError, readJsonObject, requireUuid } from "../_shared/http.ts";
import { fetchWithRetry, safeJson } from "../_shared/upstream.ts";
import { wrapHandler } from "../_shared/handler.ts";
import type { Deps } from "../_shared/deps.ts";
import { finishSyncRun, loadIntegration, newCounts, setIntegrationStatus, startSyncRun } from "../_shared/integrations.ts";
import { classifyMetaError, mapMetaAdInsightDay, mapMetaInsightDay, normalizeMetaAdAccountId } from "../_shared/mappers.ts";

export const META_GRAPH_VERSION = "v21.0";
const GRAPH_HOST = "graph.facebook.com";
/** Fields for the ad-level daily insights (one row per ad per day, with its campaign, ad set and ad names). */
export const META_AD_FIELDS =
  "date_start,campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,spend,impressions,reach,clicks,cpm,cpc,ctr,actions,action_values";

/** The next page of a Graph response, only if it stays on the Graph host (the token is never sent elsewhere). */
export function nextGraphPage(json: any): string | null {
  const next = json?.paging?.next;
  if (typeof next !== "string") return null;
  try {
    const u = new URL(next);
    return u.protocol === "https:" && u.host === GRAPH_HOST ? u.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Campaign id -> status (lower case: "active", "paused", ...). Uses effective_status, because the status
 * of an ad's campaign is not part of the insights response. A failure here is not fatal: the rows are
 * saved without a status and the next run fills it in.
 */
export async function fetchCampaignStatuses(
  deps: Pick<Deps, "fetch" | "sleep">,
  adAccountId: string,
  token: string,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const params = new URLSearchParams({ fields: "id,name,effective_status", limit: "200", access_token: token });
  let url: string | null = `https://${GRAPH_HOST}/${META_GRAPH_VERSION}/${adAccountId}/campaigns?${params}`;
  for (let page = 0; url && page < 20; page++) {
    try {
      const res = await fetchWithRetry(deps.fetch, url, { headers: { Accept: "application/json" } }, { sleep: deps.sleep });
      const json = await safeJson(res);
      if (!res.ok || !Array.isArray(json?.data)) {
        logger.warn("Meta campaign list not read", { status: res.status });
        break;
      }
      for (const c of json.data) {
        if (c?.id) out.set(String(c.id), String(c.effective_status ?? "unknown").toLowerCase());
      }
      url = nextGraphPage(json);
    } catch (e) {
      logger.warn("Meta campaign list failed", { error: (e as Error).message });
      break;
    }
  }
  return out;
}

export function createHandler(deps: Deps) {
  return wrapHandler("meta-ads-sync", async (req) => {
    const caller = await requireSyncCaller(req, deps);
    const body = await readJsonObject(req);
    const workspaceId = requireUuid(body.workspace_id, "workspace_id");
    const brandId = requireUuid(body.brand_id, "brand_id");
    const days = clampInt(body.days, 30, 1, 365);
    // A year of ad-level rows needs many pages; a 30-day window keeps the scheduled run short.
    const maxPages = clampInt(body.max_pages, days > 30 ? 80 : 10, 1, 100);

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
    const adCounts = { processed: 0, saved: 0, failed: 0 };
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

      // Campaign level: one row per ad per day, tagged with its campaign's status.
      const statusById = await fetchCampaignStatuses(deps, adAccountId, token);
      const adParams = new URLSearchParams({
        level: "ad",
        time_increment: "1",
        time_range: JSON.stringify({ since, until }),
        fields: META_AD_FIELDS,
        limit: "100",
        access_token: token,
      });
      let adUrl: string | null = `https://${GRAPH_HOST}/${META_GRAPH_VERSION}/${adAccountId}/insights?${adParams}`;
      let adPages = 0;
      while (adUrl && adPages < maxPages) {
        adPages++;
        const res = await fetchWithRetry(deps.fetch, adUrl, { headers: { Accept: "application/json" } }, { sleep: deps.sleep });
        const json = await safeJson(res);
        if (!res.ok || json?.error) {
          const err = classifyMetaError(json);
          if (err.kind === "token_invalid") {
            await setIntegrationStatus(admin, integ.id, "error", `Meta access token is invalid or expired: ${err.message}`);
          }
          throw new HttpError(502, `Meta ad-level insights error (${err.kind}): ${err.message}`, {
            upstream_status: res.status,
            meta_error_kind: err.kind,
            meta_error_code: err.code ?? null,
          });
        }
        if (!json || !Array.isArray(json.data)) throw new HttpError(502, "Meta returned an unexpected ad-level insights payload");
        for (const item of json.data) {
          adCounts.processed++;
          try {
            const row = {
              ...mapMetaAdInsightDay(item, ctx, { adAccountId, currency: String(integ.credentials.currency || "INR") }),
              campaign_status: statusById.get(String(item?.campaign_id ?? "")) ?? null,
            };
            const { error } = await admin
              .from("analytics_meta_ad_daily")
              .upsert(row, { onConflict: "brand_id,ad_id,report_date,attribution_setting" });
            if (error) throw new Error(error.message);
            adCounts.saved++;
          } catch (e) {
            adCounts.failed++;
            logger.warn("Meta ad-level row not persisted", { ad_id: String(item?.ad_id ?? ""), error: (e as Error).message });
          }
        }
        adUrl = nextGraphPage(json);
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
      ad_rows_processed: adCounts.processed,
      ad_rows_saved: adCounts.saved,
      ad_rows_failed: adCounts.failed,
      pages_fetched: pages,
      has_more: Boolean(nextUrl),
      last_synced_at: new Date().toISOString(),
    });
  });
}
