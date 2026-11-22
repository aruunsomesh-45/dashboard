import { successResponse } from "../_shared/response.ts";
import { requireAuth, requireWorkspaceAccess, requireModuleAccess } from "../_shared/auth.ts";
import { HttpError, readJsonObject, requireUuid } from "../_shared/http.ts";
import { fetchWithRetry, safeJson } from "../_shared/upstream.ts";
import { wrapHandler } from "../_shared/handler.ts";
import type { Deps } from "../_shared/deps.ts";
import { loadIntegration, setIntegrationStatus } from "../_shared/integrations.ts";
import { classifyMetaError } from "../_shared/mappers.ts";

export const META_GRAPH_VERSION = "v21.0";

/**
 * Instagram (Graph API via a Facebook Page) verification sync.
 *
 *  1. Validates the token (GET /me).
 *  2. Discovers the linked Instagram Business account (GET /me/accounts -> instagram_business_account).
 *  3. Reads account info and the most recent media (requires instagram_basic).
 *
 * Every step degrades independently: a missing permission is reported per capability instead of
 * failing the whole call, because accounts do not all grant the same scopes.
 *
 * PERSISTENCE: the current schema has no table for Instagram media/insights, so only the
 * integration's health fields and account_identifier are written. See TEST_REPORT.md.
 */
export function createHandler(deps: Deps) {
  return wrapHandler("instagram-sync", async (req) => {
    const { user, client } = await requireAuth(req, deps);
    const body = await readJsonObject(req);
    const workspaceId = requireUuid(body.workspace_id, "workspace_id");
    const brandId = requireUuid(body.brand_id, "brand_id");
    await requireWorkspaceAccess(client, user.id, workspaceId, brandId);
    await requireModuleAccess(client, user.id, workspaceId, "instagram");

    const admin = deps.adminClient();
    const integ = await loadIntegration(admin, workspaceId, brandId, "instagram");
    const token = String(integ.credentials.graph_token || integ.credentials.access_token || "").trim();
    if (!token) throw new HttpError(400, "Instagram Graph API token is required.");

    const graph = async (path: string, fields: string) => {
      const url = `https://graph.facebook.com/${META_GRAPH_VERSION}/${path}?${new URLSearchParams({ fields, access_token: token })}`;
      const res = await fetchWithRetry(deps.fetch, url, { headers: { Accept: "application/json" } }, { sleep: deps.sleep, retries: 2 });
      const json = await safeJson(res);
      return { ok: res.ok && !json?.error, status: res.status, json };
    };

    // 1. Token validity
    const me = await graph("me", "id,name");
    if (!me.ok) {
      const err = classifyMetaError(me.json);
      await setIntegrationStatus(admin, integ.id, "error", `Instagram token check failed (${err.kind}): ${err.message}`);
      throw new HttpError(502, `Instagram Graph API error (${err.kind}): ${err.message}`, { upstream_status: me.status, meta_error_kind: err.kind });
    }

    const capabilities: Record<string, { ok: boolean; error?: string }> = { token: { ok: true } };

    // 2. Linked IG business account (needs pages_show_list + instagram_basic)
    let igAccount: { id: string; username?: string; followers_count?: number; media_count?: number } | null = null;
    const pages = await graph("me/accounts", "id,name,instagram_business_account{id,username,followers_count,media_count}");
    if (pages.ok) {
      const page = (pages.json?.data ?? []).find((p: any) => p?.instagram_business_account?.id);
      igAccount = page?.instagram_business_account ?? null;
      capabilities.account = igAccount ? { ok: true } : { ok: false, error: "No Instagram Business account is linked to the token's Pages" };
    } else {
      capabilities.account = { ok: false, error: classifyMetaError(pages.json).message };
    }

    // 3. Recent media
    let mediaCount = 0;
    if (igAccount) {
      const media = await graph(`${igAccount.id}/media`, "id,media_type,timestamp,like_count,comments_count");
      if (media.ok && Array.isArray(media.json?.data)) {
        mediaCount = media.json.data.length;
        capabilities.media = { ok: true };
      } else {
        capabilities.media = { ok: false, error: classifyMetaError(media.json).message };
      }
    }

    const identifier = igAccount?.username ? `@${igAccount.username}` : String(integ.credentials.handle || integ.account_identifier || me.json.name || me.json.id);
    await setIntegrationStatus(admin, integ.id, "connected", "", { account_identifier: identifier.slice(0, 255) });

    return successResponse({
      message: igAccount ? "Instagram account verified." : "Token is valid, but no Instagram Business account could be read.",
      account_info: {
        token_owner: { id: me.json.id, name: me.json.name },
        instagram: igAccount ? { id: igAccount.id, username: igAccount.username, followers_count: igAccount.followers_count, media_count: igAccount.media_count } : null,
      },
      records_fetched: mediaCount,
      records_persisted: 0,
      capabilities,
      last_synced_at: new Date().toISOString(),
    });
  });
}
