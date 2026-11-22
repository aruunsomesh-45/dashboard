import { successResponse } from "../_shared/response.ts";
import { logger } from "../_shared/logger.ts";
import { requireAuth, requireWorkspaceAccess, requireModuleAccess } from "../_shared/auth.ts";
import { clampInt, HttpError, readJsonObject, requireUuid } from "../_shared/http.ts";
import { fetchWithRetry, safeJson } from "../_shared/upstream.ts";
import { wrapHandler } from "../_shared/handler.ts";
import type { Deps } from "../_shared/deps.ts";
import { finishSyncRun, loadIntegration, newCounts, setIntegrationStatus, startSyncRun, upsertCanonical } from "../_shared/integrations.ts";
import { mapRazorpayPayment } from "../_shared/mappers.ts";

const PAGE_SIZE = 100; // Razorpay maximum for /v1/payments

export function createHandler(deps: Deps) {
  return wrapHandler("razorpay-sync", async (req) => {
    const { user, client } = await requireAuth(req, deps);
    const body = await readJsonObject(req);
    const workspaceId = requireUuid(body.workspace_id, "workspace_id");
    const brandId = requireUuid(body.brand_id, "brand_id");
    const days = clampInt(body.days, 30, 1, 365);
    const maxPages = clampInt(body.max_pages, 5, 1, 50);

    await requireWorkspaceAccess(client, user.id, workspaceId, brandId);
    await requireModuleAccess(client, user.id, workspaceId, "razorpay");

    const admin = deps.adminClient();
    const integ = await loadIntegration(admin, workspaceId, brandId, "razorpay");
    const keyId = String(integ.credentials.key_id || integ.account_identifier || "").trim();
    const keySecret = String(integ.credentials.key_secret || "").trim();
    if (!keyId || !keySecret) throw new HttpError(400, "Razorpay key_id and key_secret are required.");

    const ctx = { workspace_id: workspaceId, brand_id: brandId };
    const auth = `Basic ${btoa(`${keyId}:${keySecret}`)}`;
    const from = Math.floor((Date.now() - days * 86_400_000) / 1000);
    const runId = await startSyncRun(admin, integ, "payments");
    const counts = newCounts();
    let pages = 0;
    let hasMore = true;

    try {
      while (hasMore && pages < maxPages) {
        const url = `https://api.razorpay.com/v1/payments?count=${PAGE_SIZE}&skip=${pages * PAGE_SIZE}&from=${from}`;
        pages++;
        const res = await fetchWithRetry(deps.fetch, url, { headers: { Authorization: auth, Accept: "application/json" } }, { sleep: deps.sleep });
        const json = await safeJson(res);

        if (!res.ok) {
          const detail = json?.error?.description || `HTTP ${res.status}`;
          if (res.status === 401) await setIntegrationStatus(admin, integ.id, "error", "Razorpay rejected the API key/secret");
          throw new HttpError(502, `Razorpay API error: ${detail}`, { upstream_status: res.status });
        }
        if (!json || !Array.isArray(json.items)) throw new HttpError(502, "Razorpay returned an unexpected payments payload");

        for (const payment of json.items) {
          counts.processed++;
          try {
            const { created } = await upsertCanonical(admin, "commerce_paymentattempt", mapRazorpayPayment(payment, ctx));
            if (created) counts.created++;
            else counts.updated++;
          } catch (e) {
            counts.failed++;
            logger.warn("Razorpay payment not persisted", { provider_id: String(payment?.id ?? ""), error: (e as Error).message });
          }
        }
        hasMore = json.items.length === PAGE_SIZE;
      }
    } catch (e) {
      await finishSyncRun(admin, runId, "failed", counts, (e as Error).message);
      throw e;
    }

    const ok = counts.processed - counts.failed;
    const status = counts.failed === 0 ? "success" : ok > 0 ? "partial" : "failed";
    await finishSyncRun(admin, runId, status, counts, counts.failed ? `${counts.failed} payment(s) failed to persist` : "");
    await setIntegrationStatus(admin, integ.id, status === "failed" ? "error" : "connected", status === "failed" ? "No Razorpay payments could be saved" : "");
    if (status === "failed") throw new HttpError(500, "Razorpay payments were fetched but none could be saved", { ...counts, sync_run_id: runId });

    return successResponse({
      message: `Razorpay sync ${status}: ${counts.created} created, ${counts.updated} updated, ${counts.failed} failed.`,
      status,
      sync_run_id: runId,
      records_processed: counts.processed,
      records_created: counts.created,
      records_updated: counts.updated,
      records_failed: counts.failed,
      pages_fetched: pages,
      has_more: hasMore,
      last_synced_at: new Date().toISOString(),
    });
  });
}
