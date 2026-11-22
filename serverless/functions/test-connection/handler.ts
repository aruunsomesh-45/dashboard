import { successResponse } from "../_shared/response.ts";
import { logger } from "../_shared/logger.ts";
import { requireAuth, requireWorkspaceAccess } from "../_shared/auth.ts";
import { decryptCredentials } from "../_shared/crypto.ts";
import { HttpError, isUuid, readJsonObject } from "../_shared/http.ts";
import { fetchWithRetry, safeJson, UpstreamError } from "../_shared/upstream.ts";
import { wrapHandler } from "../_shared/handler.ts";
import type { Deps } from "../_shared/deps.ts";
import { classifyMetaError, normalizeMetaAdAccountId, normalizeShopDomain } from "../_shared/mappers.ts";

export interface ConnectionTestResult {
  integration_name: string;
  connection_status: "connected" | "failed";
  http_status: number;
  response_time: number;
  last_tested_at: string;
  records_fetched: number;
  error_message: string | null;
  account_info?: { identifier?: string; name?: string };
}

type Creds = Record<string, unknown>;

export function createHandler(deps: Deps) {
  return wrapHandler("test-connection", async (req) => {
    const started = Date.now();
    const { user, client } = await requireAuth(req, deps);
    const body = await readJsonObject(req);

    let provider = typeof body.provider === "string" ? body.provider : "";
    let credentials: Creds = body.credentials && typeof body.credentials === "object" ? (body.credentials as Creds) : {};
    let identifier = typeof body.account_identifier === "string" ? body.account_identifier : "";

    if (body.integration_id !== undefined) {
      if (!isUuid(body.integration_id)) throw new HttpError(400, "Invalid integration_id: must be a UUID");
      const admin = deps.adminClient();
      const { data: integ, error } = await admin
        .from("integrations_integration")
        .select("id, provider, workspace_id, brand_id, account_identifier, encrypted_credentials")
        .eq("id", body.integration_id)
        .maybeSingle();
      if (error) throw new Error(`Integration lookup failed: ${error.message}`);
      // Same 404 whether it doesn't exist or belongs to another workspace (no existence oracle).
      if (!integ) throw new HttpError(404, "Integration record not found");
      try {
        await requireWorkspaceAccess(client, user.id, integ.workspace_id, integ.brand_id);
      } catch {
        throw new HttpError(404, "Integration record not found");
      }
      provider = integ.provider;
      identifier = integ.account_identifier;
      if (integ.encrypted_credentials) credentials = await decryptCredentials(integ.encrypted_credentials);
    } else if (body.workspace_id !== undefined) {
      if (!isUuid(body.workspace_id)) throw new HttpError(400, "Invalid workspace_id: must be a UUID");
      if (body.brand_id !== undefined && !isUuid(body.brand_id)) throw new HttpError(400, "Invalid brand_id: must be a UUID");
      await requireWorkspaceAccess(client, user.id, body.workspace_id, body.brand_id as string | undefined);
    }

    if (!provider) throw new HttpError(400, "Missing required 'provider' or 'integration_id'");

    let result: ConnectionTestResult;
    switch (provider.toLowerCase()) {
      case "shopify":
        result = await testShopify(deps, credentials, identifier, started);
        break;
      case "razorpay":
        result = await testRazorpay(deps, credentials, identifier, started);
        break;
      case "meta":
      case "meta_ads":
        result = await testMetaAds(deps, credentials, identifier, started);
        break;
      case "instagram":
        result = await testInstagram(deps, credentials, identifier, started);
        break;
      default:
        throw new HttpError(400, `Unsupported integration provider: ${provider}`);
    }

    logger.info("Connection test completed", {
      provider: result.integration_name,
      status: result.connection_status,
      http_status: result.http_status,
      duration_ms: result.response_time,
    });
    return successResponse<ConnectionTestResult>(result);
  });
}

function failed(name: string, started: number, http: number, msg: string): ConnectionTestResult {
  return {
    integration_name: name,
    connection_status: "failed",
    http_status: http,
    response_time: Date.now() - started,
    last_tested_at: new Date().toISOString(),
    records_fetched: 0,
    error_message: msg,
  };
}

/** One upstream GET with a 10s timeout and a single retry; transport failures become a failed result. */
async function probe(deps: Deps, name: string, started: number, url: string, headers: Record<string, string>) {
  try {
    const res = await fetchWithRetry(deps.fetch, url, { headers: { Accept: "application/json", ...headers } }, {
      retries: 1,
      timeoutMs: 10_000,
      sleep: deps.sleep,
    });
    return { res, json: await safeJson(res) };
  } catch (e) {
    const msg = e instanceof UpstreamError ? e.message : `Network error: ${(e as Error).message}`;
    return { error: failed(name, started, e instanceof UpstreamError && e.kind === "timeout" ? 504 : 502, msg) };
  }
}

async function testShopify(deps: Deps, creds: Creds, identifier: string, started: number): Promise<ConnectionTestResult> {
  const token = String(creds.access_token || "").trim();
  let shop: string;
  try {
    shop = normalizeShopDomain(creds.shop_domain || creds.shop_url || identifier);
  } catch (e) {
    return failed("shopify", started, 400, (e as Error).message);
  }
  if (!token) return failed("shopify", started, 400, "Shop domain and Admin API Access Token (shpat_...) are required.");
  if (token.startsWith("shpss_")) {
    return failed("shopify", started, 400, "You entered the API Secret Key (shpss_...). Please enter the Admin API Access Token (shpat_...).");
  }

  const p = await probe(deps, "shopify", started, `https://${shop}/admin/api/2024-10/shop.json`, { "X-Shopify-Access-Token": token });
  if (p.error) return p.error;
  const { res, json } = p;
  if (!res.ok) {
    return failed("shopify", started, res.status, json?.errors ? JSON.stringify(json.errors) : `Shopify API responded with status ${res.status}`);
  }
  if (!json?.shop) return failed("shopify", started, res.status, "Shopify responded without a shop object");
  return {
    integration_name: "shopify",
    connection_status: "connected",
    http_status: res.status,
    response_time: Date.now() - started,
    last_tested_at: new Date().toISOString(),
    records_fetched: 1,
    error_message: null,
    account_info: { identifier: json.shop.myshopify_domain || shop, name: json.shop.name },
  };
}

async function testRazorpay(deps: Deps, creds: Creds, identifier: string, started: number): Promise<ConnectionTestResult> {
  const keyId = String(creds.key_id || identifier || "").trim();
  const keySecret = String(creds.key_secret || "").trim();
  if (!keyId || !keySecret) return failed("razorpay", started, 400, "Razorpay Key ID and Key Secret are required.");
  if (!/^rzp_(test|live)_[A-Za-z0-9]+$/.test(keyId)) return failed("razorpay", started, 400, "Razorpay Key ID must start with rzp_test_ or rzp_live_.");

  const p = await probe(deps, "razorpay", started, "https://api.razorpay.com/v1/payments?count=1", {
    Authorization: `Basic ${btoa(`${keyId}:${keySecret}`)}`,
  });
  if (p.error) return p.error;
  const { res, json } = p;
  if (!res.ok) return failed("razorpay", started, res.status, json?.error?.description || `Razorpay API responded with status ${res.status}`);
  if (!Array.isArray(json?.items)) return failed("razorpay", started, res.status, "Razorpay responded without an items array");
  return {
    integration_name: "razorpay",
    connection_status: "connected",
    http_status: res.status,
    response_time: Date.now() - started,
    last_tested_at: new Date().toISOString(),
    records_fetched: json.items.length,
    error_message: null,
    account_info: { identifier: keyId.startsWith("rzp_live_") ? "live mode" : "test mode" },
  };
}

async function testMetaAds(deps: Deps, creds: Creds, identifier: string, started: number): Promise<ConnectionTestResult> {
  let adAccountId: string;
  try {
    adAccountId = normalizeMetaAdAccountId(creds.ad_account_id || identifier);
  } catch (e) {
    return failed("meta_ads", started, 400, (e as Error).message);
  }
  const token = String(creds.access_token || "").trim();
  if (!adAccountId || !token) return failed("meta_ads", started, 400, "Ad Account ID and System User Access Token are required.");

  const qs = new URLSearchParams({ fields: "id,name,account_status,currency", access_token: token });
  const p = await probe(deps, "meta_ads", started, `https://graph.facebook.com/v21.0/${adAccountId}?${qs}`, {});
  if (p.error) return p.error;
  const { res, json } = p;
  if (!res.ok || json?.error) {
    const err = classifyMetaError(json);
    return failed("meta_ads", started, res.status, `${err.message} (${err.kind})`);
  }
  return {
    integration_name: "meta_ads",
    connection_status: "connected",
    http_status: res.status,
    response_time: Date.now() - started,
    last_tested_at: new Date().toISOString(),
    records_fetched: 1,
    error_message: null,
    account_info: { identifier: json.id || adAccountId, name: json.name },
  };
}

async function testInstagram(deps: Deps, creds: Creds, identifier: string, started: number): Promise<ConnectionTestResult> {
  const handle = String(creds.handle || identifier || "").trim();
  const token = String(creds.graph_token || creds.access_token || "").trim();
  if (!token) return failed("instagram", started, 400, "Instagram Graph API User Token is required.");

  const qs = new URLSearchParams({ fields: "id,name", access_token: token });
  const p = await probe(deps, "instagram", started, `https://graph.facebook.com/v21.0/me?${qs}`, {});
  if (p.error) return p.error;
  const { res, json } = p;
  if (!res.ok || json?.error) {
    const err = classifyMetaError(json);
    return failed("instagram", started, res.status, `${err.message} (${err.kind})`);
  }
  return {
    integration_name: "instagram",
    connection_status: "connected",
    http_status: res.status,
    response_time: Date.now() - started,
    last_tested_at: new Date().toISOString(),
    records_fetched: 1,
    error_message: null,
    account_info: { identifier: handle || json.name || json.id, name: json.name },
  };
}
