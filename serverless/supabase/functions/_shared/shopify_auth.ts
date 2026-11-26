import { HttpError } from "./http.ts";
import type { Deps } from "./deps.ts";
import { fetchWithRetry, safeJson } from "./upstream.ts";

/**
 * Shopify Admin API token from the app's Client ID and Client secret (client credentials grant).
 * Shopify's tokens from this grant last about 24 hours, so the dashboard asks for a fresh one at the start of
 * every sync and connection test. Nothing expires in the saved settings.
 * Works only when the app is installed on the store and both belong to the same Dev Dashboard organization.
 */
export async function exchangeShopifyToken(
  deps: Pick<Deps, "fetch" | "sleep">,
  shopDomain: string,
  clientId: string,
  clientSecret: string,
): Promise<string> {
  const res = await fetchWithRetry(
    deps.fetch,
    `https://${shopDomain}/admin/oauth/access_token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
    },
    { sleep: deps.sleep },
  );
  const json = await safeJson(res);
  const token = typeof json?.access_token === "string" ? json.access_token.trim() : "";
  if (!res.ok || !token) {
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      throw new HttpError(
        401,
        `Shopify rejected the Client ID or Client secret (${res.status}). Check both values, and that the app is installed on ${shopDomain}.`,
        { upstream_status: res.status },
      );
    }
    throw new HttpError(502, `Shopify token request failed (HTTP ${res.status})`, { upstream_status: res.status });
  }
  return token;
}
