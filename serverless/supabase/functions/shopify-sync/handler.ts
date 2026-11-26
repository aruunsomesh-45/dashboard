import { successResponse } from "../_shared/response.ts";
import { logger } from "../_shared/logger.ts";
import { authorizeSyncScope, requireSyncCaller } from "../_shared/auth.ts";
import { clampInt, HttpError, readJsonObject, requireUuid } from "../_shared/http.ts";
import { fetchWithRetry, safeJson } from "../_shared/upstream.ts";
import { wrapHandler } from "../_shared/handler.ts";
import type { Deps } from "../_shared/deps.ts";
import {
  CURSOR_OVERLAP_MS,
  finishSyncRun,
  loadCursor,
  loadIntegration,
  newCounts,
  saveCursor,
  setIntegrationStatus,
  startSyncRun,
} from "../_shared/integrations.ts";
import { extractShopifyNextPageUrl, normalizeShopDomain } from "../_shared/mappers.ts";
import { exchangeShopifyToken } from "../_shared/shopify_auth.ts";
import { processShopifyOrder } from "../_shared/pipeline.ts";

export const SHOPIFY_API_VERSION = "2024-10";

export function createHandler(deps: Deps) {
  return wrapHandler("shopify-sync", async (req) => {
    const caller = await requireSyncCaller(req, deps);
    const body = await readJsonObject(req);
    const workspaceId = requireUuid(body.workspace_id, "workspace_id");
    const brandId = requireUuid(body.brand_id, "brand_id");
    // Explicit `days` = historical backfill window; otherwise continue from the stored checkpoint.
    const explicitDays = body.days !== undefined && body.days !== null && body.days !== "";
    const days = clampInt(body.days, 90, 1, 365);
    const maxPages = clampInt(body.max_pages, 5, 1, 50);

    await authorizeSyncScope(caller, workspaceId, brandId, "shopify");

    const admin = deps.adminClient();
    const integ = await loadIntegration(admin, workspaceId, brandId, "shopify");
    const shopDomain = normalizeShopDomain(integ.credentials.shop_domain || integ.credentials.shop_url || integ.account_identifier);
    // Preferred: exchange the Client ID and Client secret for a fresh token (renewed on every run).
    // Legacy: a stored Admin API access token (shpat_...), used only when no Client ID is saved.
    const clientId = String(integ.credentials.client_id || "").trim();
    const clientSecret = String(integ.credentials.client_secret || "").trim();
    let token: string;
    if (clientId && clientSecret) {
      try {
        token = await exchangeShopifyToken(deps, shopDomain, clientId, clientSecret);
      } catch (e) {
        await setIntegrationStatus(admin, integ.id, "error", (e as Error).message);
        throw e;
      }
    } else {
      token = String(integ.credentials.access_token || "").trim();
      if (!token) throw new HttpError(400, "Enter the Shopify Client ID and Client secret on the Shopify card.");
      if (token.startsWith("shpss_")) {
        throw new HttpError(400, "Stored token is the API secret key (shpss_...), not an Admin API access token (shpat_...).");
      }
    }

    const ctx = { workspace_id: workspaceId, brand_id: brandId };
    const runId = await startSyncRun(admin, integ, "orders", caller.kind === "cron" ? "cron" : "manual");
    const counts = newCounts();
    const cursor = explicitDays ? null : await loadCursor(admin, integ, "orders");
    const mode = cursor ? "incremental" : explicitDays ? "backfill" : "initial";
    const since = cursor
      ? new Date(Date.parse(cursor) - CURSOR_OVERLAP_MS).toISOString()
      : new Date(Date.now() - days * 86_400_000).toISOString();
    // updated_at (not created_at) so edits, refunds and cancellations of older orders are picked up;
    // ascending order lets the checkpoint advance safely page by page.
    let nextUrl: string | null =
      `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/orders.json?status=any&limit=250&order=updated_at%20asc&updated_at_min=${encodeURIComponent(since)}`;
    let pages = 0;
    // The checkpoint only moves through the unbroken prefix of saved orders: a failed order is
    // re-read next run (it is also kept as a failed raw payload for re-processing).
    let checkpoint: string | null = null;
    let prefixIntact = true;
    const source = mode === "backfill" ? "backfill" : "sync";

    try {
      while (nextUrl && pages < maxPages) {
        pages++;
        const res = await fetchWithRetry(deps.fetch, nextUrl, {
          headers: { "X-Shopify-Access-Token": token, Accept: "application/json" },
        }, { sleep: deps.sleep });

        if (!res.ok) {
          const err = await safeJson(res);
          const detail = err?.errors ? JSON.stringify(err.errors) : `HTTP ${res.status}`;
          if (res.status === 401 || res.status === 403) {
            // 401: the token itself is not accepted. 403: the token works, but the app may not read this data.
            const why = res.status === 401
              ? "Shopify does not accept the access token. Check the Client ID and Client secret."
              : "Shopify accepted the token but refused the data (403). The app needs the read_orders, read_customers and read_products permissions, a released version, and approval to read customer data.";
            const said = typeof err?.errors === "string" ? ` Shopify said: "${err.errors.slice(0, 160)}".` : "";
            await setIntegrationStatus(admin, integ.id, "error", `${why}${said}`);
          }
          throw new HttpError(502, `Shopify API error: ${detail}`, { upstream_status: res.status });
        }

        // Leaky-bucket back-off (REST: "X-Shopify-Shop-Api-Call-Limit: 39/40").
        const [used, limit] = (res.headers.get("X-Shopify-Shop-Api-Call-Limit") ?? "").split("/").map(Number);
        if (used && limit && used >= limit - 2) await deps.sleep(1000);

        const json = await safeJson(res);
        if (!json || !Array.isArray(json.orders)) {
          throw new HttpError(502, "Shopify returned an unexpected orders payload");
        }

        for (const order of json.orders) {
          counts.processed++;
          try {
            const { created } = await processShopifyOrder(admin, ctx, order, { source });
            if (created) counts.created++;
            else counts.updated++;
            const updated = Date.parse(String(order?.updated_at ?? ""));
            if (prefixIntact && Number.isFinite(updated)) checkpoint = new Date(updated).toISOString();
          } catch (e) {
            prefixIntact = false;
            counts.failed++;
            logger.warn("Shopify order not persisted", { provider_id: String(order?.id ?? ""), error: (e as Error).message });
          }
        }

        nextUrl = extractShopifyNextPageUrl(res.headers.get("Link"), shopDomain);
      }
    } catch (e) {
      if (checkpoint) await saveCursor(admin, integ, "orders", checkpoint);
      await finishSyncRun(admin, runId, "failed", counts, (e as Error).message);
      throw e;
    }
    const cursorAdvanced = checkpoint ? await saveCursor(admin, integ, "orders", checkpoint) : false;

    const ok = counts.processed - counts.failed;
    const status = counts.failed === 0 ? "success" : ok > 0 ? "partial" : "failed";
    await finishSyncRun(admin, runId, status, counts, counts.failed ? `${counts.failed} order(s) failed to persist` : "");
    await setIntegrationStatus(
      admin,
      integ.id,
      status === "failed" ? "error" : "connected",
      status === "failed" ? "No Shopify orders could be saved" : "",
    );

    if (status === "failed") {
      throw new HttpError(500, "Shopify orders were fetched but none could be saved", { ...counts, sync_run_id: runId });
    }

    return successResponse({
      message: `Shopify sync ${status}: ${counts.created} created, ${counts.updated} updated, ${counts.failed} failed.`,
      status,
      sync_run_id: runId,
      records_processed: counts.processed,
      records_created: counts.created,
      records_updated: counts.updated,
      records_failed: counts.failed,
      pages_fetched: pages,
      has_more: Boolean(nextUrl),
      mode,
      window_start: since,
      cursor: cursorAdvanced ? checkpoint : cursor,
      last_synced_at: new Date().toISOString(),
    });
  });
}
