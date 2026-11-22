import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getAdminClient } from "@/lib/supabaseServer";
import {
  ADMIN_ROLES,
  RouteError,
  SessionContext,
  TenantContext,
  errorJson,
  requireSession,
  requireTenant,
  withSessionCookies,
} from "@/lib/serverAuth";
import { decryptCredentialsFromPgHex, encryptCredentialsToPgHex, isEncryptionConfigured } from "@/lib/credentialCrypto";

/**
 * Catch-all dashboard API (a Vercel serverless function).
 *
 * Every route below authenticates the Supabase session and verifies workspace membership + brand ownership
 * BEFORE the service-role client reads tenant data. Routes with no real data source answer an explicit
 * error instead of fabricated success. Unknown paths are 404.
 */
export const dynamic = "force-dynamic";

type Params = { params: { path?: string[] } };
export const GET = (req: NextRequest, { params }: Params) => handleRequest(req, params?.path || [], "GET");
export const POST = (req: NextRequest, { params }: Params) => handleRequest(req, params?.path || [], "POST");
export const PUT = (req: NextRequest, { params }: Params) => handleRequest(req, params?.path || [], "PUT");
export const PATCH = (req: NextRequest, { params }: Params) => handleRequest(req, params?.path || [], "PATCH");
export const DELETE = (req: NextRequest, { params }: Params) => handleRequest(req, params?.path || [], "DELETE");

const PROVIDERS = new Set(["shopify", "razorpay", "shiprocket", "meta_ads", "instagram"]);
const PROVIDER_DISPLAY: Record<string, string> = {
  shopify: "Shopify",
  razorpay: "Razorpay",
  shiprocket: "Shiprocket",
  meta_ads: "Meta Ads",
  instagram: "Instagram",
};
const SYNC_FUNCTIONS: Record<string, string> = {
  "shopify/sync-now": "shopify-sync",
  "marketing/sync-now": "meta-ads-sync",
  "payments/sync-now": "razorpay-sync",
  "instagram/sync-now": "instagram-sync",
};

function notAvailable(feature: string) {
  return NextResponse.json(
    { error: `${feature} is not available in the serverless deployment yet.` },
    { status: 501 },
  );
}

async function handleRequest(req: NextRequest, rawPathParts: string[], method: string) {
  const pathParts = rawPathParts.filter(Boolean);
  const fullPath = pathParts.join("/");
  try {
    // ── Unported account features (were Django-only) ───────────────────────────
    if (fullPath.startsWith("auth/password-reset")) return notAvailable("Password reset");
    if (/(^|\/)mfa\//.test(fullPath + "/")) {
      const session = await requireSession(req);
      // Supabase Auth has no TOTP factor enrolled for these users; report that truthfully.
      if (fullPath.endsWith("mfa/status") && method === "GET") {
        return withSessionCookies(
          NextResponse.json({ is_enabled: false, is_pending: false, unused_recovery_codes_count: 0, confirmed_at: null }),
          session,
        );
      }
      return notAvailable("Two-factor authentication");
    }

    // ── /w/:slug/... ──────────────────────────────────────────────────────────
    if (pathParts[0] !== "w" || pathParts.length < 3) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const wsSlug = pathParts[1];
    const admin = getAdminClient();
    const session = await requireSession(req, admin);
    const respond = (body: unknown, status = 200) => withSessionCookies(NextResponse.json(body, { status }), session);

    // /w/:slug/b/:brandId/<action>
    if (pathParts[2] === "b" && pathParts.length >= 5) {
      const brandId = pathParts[3];
      const action = pathParts.slice(4).join("/");
      const isWrite = method !== "GET";
      const writeNeedsAdmin = action === "integrations" || action.startsWith("logistics/ndr/");
      const tenant = await requireTenant(admin, session, wsSlug, brandId, isWrite && writeNeedsAdmin ? ADMIN_ROLES : undefined);
      const days = clampDays(req.nextUrl.searchParams.get("days"));

      if (method === "GET") {
        switch (action) {
          case "shopify/stats":
            return respond(await shopifyStats(admin, tenant, days));
          case "metrics":
            return respond(await overviewMetrics(admin, tenant, days));
          case "payments/stats":
          case "payments":
            return respond(await paymentStats(admin, tenant));
          case "payments/transactions":
            return respond(await paymentTransactions(admin, tenant, req));
          case "marketing/stats":
            return respond(await marketingStats(admin, tenant));
          case "logistics/summary":
            return respond(await logisticsSummary(admin, tenant));
          case "logistics/shipments":
          case "logistics":
            return respond(await logisticsShipments(admin, tenant, req));
          case "integrations":
            return respond(await listIntegrations(admin, tenant));
        }
      }
      if (action === "integrations" && (method === "POST" || method === "PUT")) {
        return respond(await saveIntegration(admin, tenant, req));
      }
      if (action === "integrations" && method === "DELETE") {
        return respond(await disconnectIntegration(admin, tenant, req));
      }
      if (method === "POST" && SYNC_FUNCTIONS[action]) {
        const res = await forwardToEdgeFunction(SYNC_FUNCTIONS[action], session, {
          workspace_id: tenant.workspaceId,
          brand_id: tenant.brand!.id,
        });
        return withSessionCookies(res, session);
      }
      if (method === "POST" && action.startsWith("logistics/ndr/")) {
        return notAvailable("Carrier NDR actions");
      }
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // /w/:slug/members, /w/:slug/invites
    const sub = pathParts.slice(2).join("/");
    if (sub === "members" && method === "GET") {
      const tenant = await requireTenant(admin, session, wsSlug, null);
      const { data, error } = await admin
        .from("tenancy_workspacemember")
        .select("id, role, created_at, user:accounts_user(id, email, first_name, last_name, mfa_enabled, created_at)")
        .eq("workspace_id", tenant.workspaceId);
      if (error) throw new Error(error.message);
      return respond(data || []);
    }
    if (sub === "invites" && method === "POST") {
      await requireTenant(admin, session, wsSlug, null, ADMIN_ROLES);
      return notAvailable("Team invitations");
    }
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  } catch (err) {
    return errorJson(err);
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

function clampDays(raw: string | null): number {
  const n = parseInt(raw || "30", 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, 1), 365) : 30;
}

function clampLimit(req: NextRequest, fallback = 100): number {
  const n = parseInt(req.nextUrl.searchParams.get("limit") || String(fallback), 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, 1), 500) : fallback;
}

function sinceIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

/** PostgREST caps a response at max-rows (1000 by default); page through so totals are not silently truncated. */
async function fetchAll<T>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: any }>, cap = 50_000): Promise<T[]> {
  const out: T[] = [];
  const page = 1000;
  for (let from = 0; from < cap; from += page) {
    const { data, error } = await build(from, from + page - 1);
    if (error) throw new Error(error.message);
    out.push(...(data || []));
    if (!data || data.length < page) break;
  }
  return out;
}

const sum = (rows: any[], key: string) => rows.reduce((s, r) => s + (Number(r[key]) || 0), 0);

async function shopifyStats(admin: SupabaseClient, tenant: TenantContext, days: number) {
  const brandId = tenant.brand!.id;
  const orders = await fetchAll<any>((from, to) =>
    admin
      .from("commerce_order")
      .select(
        "id, provider_id, order_number, currency, gross_amount, discount_amount, tax_amount, shipping_amount, net_sales, financial_status, fulfillment_status, cancelled_at, source_created_at, customer:commerce_customer(email, first_name, last_name)",
      )
      .eq("brand_id", brandId)
      .gte("source_created_at", sinceIso(days))
      .order("source_created_at", { ascending: false })
      .range(from, to),
  );
  const live = orders.filter((o) => !o.cancelled_at);
  const net = sum(live, "net_sales");
  const count = live.length;

  const recent = orders.slice(0, 50);
  const lineCounts = new Map<string, number>();
  if (recent.length) {
    const { data: lines } = await admin.from("commerce_orderline").select("order_id").in("order_id", recent.map((o) => o.id));
    for (const l of lines || []) lineCounts.set(l.order_id, (lineCounts.get(l.order_id) || 0) + 1);
  }

  return {
    brand: tenant.brand,
    days,
    metrics: {
      gross_sales_minor: sum(live, "gross_amount"),
      net_sales_minor: net,
      discount_total_minor: sum(live, "discount_amount"),
      tax_total_minor: sum(live, "tax_amount"),
      shipping_total_minor: sum(live, "shipping_amount"),
      order_count: count,
      aov_minor: count ? Math.round(net / count) : 0,
    },
    funnel: {
      placed: count,
      paid: live.filter((o) => o.financial_status === "paid").length,
      fulfilled: live.filter((o) => o.fulfillment_status === "fulfilled").length,
      partial: live.filter((o) => o.fulfillment_status === "partial").length,
      unfulfilled: live.filter((o) => o.fulfillment_status === "unfulfilled").length,
    },
    orders: recent.map((o) => ({
      id: o.id,
      provider_id: o.provider_id,
      order_number: o.order_number || "",
      customer_email: o.customer?.email || "",
      customer_name: [o.customer?.first_name, o.customer?.last_name].filter(Boolean).join(" ") || "Guest",
      currency: o.currency,
      gross_amount: o.gross_amount,
      discount_amount: o.discount_amount,
      tax_amount: o.tax_amount,
      shipping_amount: o.shipping_amount,
      net_sales: o.net_sales,
      financial_status: o.financial_status,
      fulfillment_status: o.fulfillment_status,
      source_created_at: o.source_created_at,
      lines_count: lineCounts.get(o.id) || 0,
    })),
  };
}

async function overviewMetrics(admin: SupabaseClient, tenant: TenantContext, days: number) {
  const brandId = tenant.brand!.id;
  const since = sinceIso(days);
  const [orders, ads] = await Promise.all([
    fetchAll<any>((from, to) =>
      admin
        .from("commerce_order")
        .select("net_sales, fulfillment_status, financial_status, cancelled_at, source_created_at")
        .eq("brand_id", brandId)
        .is("cancelled_at", null)
        .range(from, to),
    ),
    fetchAll<any>((from, to) =>
      admin.from("analytics_factadsdaily").select("spend_minor").eq("brand_id", brandId).gte("fact_date", since.slice(0, 10)).range(from, to),
    ),
  ]);
  const toShip = orders.filter((o) => o.fulfillment_status === "unfulfilled" && o.financial_status === "paid").length;
  const windowNet = sum(orders.filter((o) => o.source_created_at && o.source_created_at >= since), "net_sales");
  const spend = sum(ads, "spend_minor");
  const na = { value: null, available: false };
  return {
    metrics: {
      // Blended ROAS = net sales / Meta spend over the same window; unavailable until ad spend is synced.
      blended_roas: spend > 0 ? { value: Math.round((windowNet / spend) * 100) / 100, available: true } : na,
      blended_cac: na,
      delivery_success_pct: na,
      orders_to_be_shipped: { value: toShip, available: true },
      number_of_disputes: na, // no dispute source is synced
      organic_engagement: na,
    },
  };
}

async function integrationStatus(admin: SupabaseClient, brandId: string, provider: string) {
  const { data } = await admin
    .from("integrations_integration")
    .select("status, last_synced_at, last_error_message")
    .eq("brand_id", brandId)
    .eq("provider", provider)
    .maybeSingle();
  return data;
}

async function paymentStats(admin: SupabaseClient, tenant: TenantContext) {
  const brandId = tenant.brand!.id;
  const [attempts, integ] = await Promise.all([
    fetchAll<any>((from, to) => admin.from("commerce_paymentattempt").select("status, method, amount_minor").eq("brand_id", brandId).range(from, to)),
    integrationStatus(admin, brandId, "razorpay"),
  ]);
  const captured = attempts.filter((p) => p.status === "captured");
  const byMethod: Record<string, number> = {};
  for (const p of captured) byMethod[p.method || "other"] = (byMethod[p.method || "other"] || 0) + 1;
  const method_splits: Record<string, number> = {};
  for (const [m, n] of Object.entries(byMethod)) method_splits[m] = Math.round((n / captured.length) * 1000) / 10;
  return {
    connected: integ?.status === "connected",
    provider: "razorpay",
    payment_count: captured.length,
    attempt_count: attempts.length,
    authorized_rate: attempts.length ? Math.round((captured.length / attempts.length) * 1000) / 10 : null,
    total_captured_minor: sum(captured, "amount_minor"),
    total_fees_minor: null, // Razorpay fees are not synced
    method_splits,
  };
}

async function paymentTransactions(admin: SupabaseClient, tenant: TenantContext, req: NextRequest) {
  const { data, error } = await admin
    .from("commerce_paymentattempt")
    .select("id, provider_id, gateway_order_id, amount_minor, currency, status, method, error_code, source_created_at, created_at")
    .eq("brand_id", tenant.brand!.id)
    .order("source_created_at", { ascending: false, nullsFirst: false })
    .limit(clampLimit(req));
  if (error) throw new Error(error.message);
  return (data || []).map((p) => ({
    id: p.provider_id || p.id,
    order_id: p.gateway_order_id || "",
    amount_minor: p.amount_minor,
    currency: p.currency,
    status: p.status,
    method: p.method,
    error_code: p.error_code || null,
    created_at: p.source_created_at || p.created_at,
  }));
}

function summarizeAds(rows: any[]) {
  const spend = sum(rows, "spend_minor");
  const impressions = sum(rows, "impressions");
  const clicks = sum(rows, "clicks");
  const orders = sum(rows, "attributed_conversions");
  const revenue = sum(rows, "attributed_revenue_minor");
  return {
    spend_minor: spend,
    impressions,
    clicks,
    ctr: impressions ? Math.round((clicks / impressions) * 10000) / 100 : 0,
    cpc_minor: clicks ? Math.round(spend / clicks) : 0,
    cpm_minor: impressions ? Math.round((spend / impressions) * 1000) : 0,
    orders,
    attributed_revenue_minor: revenue,
    roas: spend ? Math.round((revenue / spend) * 100) / 100 : 0,
  };
}

async function marketingStats(admin: SupabaseClient, tenant: TenantContext) {
  const brandId = tenant.brand!.id;
  const integ = await integrationStatus(admin, brandId, "meta_ads");
  if (!integ || integ.status === "disconnected") {
    return { connected: false, message: "Meta Ads is not connected for this brand." };
  }
  const rows = await fetchAll<any>((from, to) =>
    admin
      .from("analytics_factadsdaily")
      .select("fact_date, spend_minor, impressions, clicks, attributed_conversions, attributed_revenue_minor")
      .eq("brand_id", brandId)
      .order("fact_date", { ascending: true })
      .range(from, to),
  );
  const cutoff = sinceIso(30).slice(0, 10);
  const last30 = rows.filter((r) => r.fact_date >= cutoff);
  return {
    connected: true,
    token_expired: integ.status === "token_expiring" || /token/i.test(integ.last_error_message || ""),
    error: integ.status === "error" ? integ.last_error_message || "Last sync failed" : undefined,
    summary_30d: summarizeAds(last30),
    summary_lifetime: summarizeAds(rows),
    campaigns: [], // campaign-level rows are not persisted by meta-ads-sync (daily account facts only)
    daily_trends: last30.map((r) => ({
      date: r.fact_date,
      spend_minor: r.spend_minor,
      impressions: r.impressions,
      clicks: r.clicks,
      orders: r.attributed_conversions,
      attributed_revenue_minor: r.attributed_revenue_minor,
      roas: r.spend_minor ? Math.round((r.attributed_revenue_minor / r.spend_minor) * 100) / 100 : 0,
    })),
    last_synced_at: integ.last_synced_at || undefined,
  };
}

async function logisticsSummary(admin: SupabaseClient, tenant: TenantContext) {
  const rows = await fetchAll<any>((from, to) =>
    admin.from("commerce_shipment").select("canonical_status, ndr_count, shipped_at, delivered_at").eq("brand_id", tenant.brand!.id).range(from, to),
  );
  const total = rows.length;
  const delivered = rows.filter((r) => r.canonical_status === "delivered");
  const rto = rows.filter((r) => r.canonical_status === "rto_initiated" || r.canonical_status === "rto_delivered").length;
  const ndr = rows.filter((r) => r.ndr_count > 0).length;
  const durations = delivered
    .filter((r) => r.shipped_at && r.delivered_at)
    .map((r) => (Date.parse(r.delivered_at) - Date.parse(r.shipped_at)) / 86_400_000);
  const pct = (n: number) => (total ? Math.round((n / total) * 1000) / 10 : null);
  return {
    total_shipments: total,
    in_transit_count: rows.filter((r) => ["in_transit", "out_for_delivery", "pickup_pending"].includes(r.canonical_status)).length,
    delivered_count: delivered.length,
    ndr_count: ndr,
    ndr_rate_percentage: pct(ndr),
    rto_rate_percentage: pct(rto),
    avg_delivery_days: durations.length ? Math.round((durations.reduce((a, b) => a + b, 0) / durations.length) * 10) / 10 : null,
  };
}

async function logisticsShipments(admin: SupabaseClient, tenant: TenantContext, req: NextRequest) {
  const { data, error } = await admin
    .from("commerce_shipment")
    .select("id, awb, courier_name, canonical_status, ndr_count, shipped_at, delivered_at")
    .eq("brand_id", tenant.brand!.id)
    .order("created_at", { ascending: false })
    .limit(clampLimit(req));
  if (error) throw new Error(error.message);
  return (data || []).map((s) => ({
    id: s.id,
    awb: s.awb,
    carrier: s.courier_name,
    status: s.canonical_status,
    ndr_count: s.ndr_count,
    dispatched_at: s.shipped_at,
    delivered_at: s.delivered_at,
  }));
}

async function listIntegrations(admin: SupabaseClient, tenant: TenantContext) {
  const { data, error } = await admin
    .from("integrations_integration")
    .select("id, provider, status, account_identifier, last_synced_at, last_error_message, created_at, updated_at")
    .eq("brand_id", tenant.brand!.id);
  if (error) throw new Error(error.message);
  return (data || []).map((i) => ({
    ...i,
    provider_display: PROVIDER_DISPLAY[i.provider] || i.provider,
    status_display: i.status,
  }));
}

async function saveIntegration(admin: SupabaseClient, tenant: TenantContext, req: NextRequest) {
  const body = await req.json().catch(() => null);
  const provider = String(body?.provider || "");
  if (!PROVIDERS.has(provider)) throw new RouteError(400, "Unsupported integration provider");
  const incoming = body?.credentials;
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
    throw new RouteError(400, "credentials must be an object");
  }
  if (!isEncryptionConfigured()) {
    throw new RouteError(503, "Credential storage is not configured on the server (INTEGRATION_ENCRYPTION_KEY).");
  }

  const brandId = tenant.brand!.id;
  const { data: existing } = await admin
    .from("integrations_integration")
    .select("id, encrypted_credentials")
    .eq("brand_id", brandId)
    .eq("provider", provider)
    .maybeSingle();

  // Merge: blank fields keep the stored secret, so re-saving the account id does not wipe the token.
  let merged: Record<string, unknown> = {};
  if (existing?.encrypted_credentials) {
    try {
      merged = decryptCredentialsFromPgHex(String(existing.encrypted_credentials));
    } catch {
      merged = {};
    }
  }
  for (const [k, v] of Object.entries(incoming as Record<string, unknown>)) {
    const s = typeof v === "string" ? v.trim() : "";
    if (s) merged[k] = s;
  }
  if (Object.keys(merged).length === 0) throw new RouteError(400, "Enter the integration credentials");

  const row = {
    workspace_id: tenant.workspaceId,
    brand_id: brandId,
    provider,
    account_identifier: String(body?.account_identifier || "").trim().slice(0, 255),
    encrypted_credentials: encryptCredentialsToPgHex(merged),
    status: "connected",
    last_error_message: "",
  };
  const { data, error } = await admin
    .from("integrations_integration")
    .upsert(row, { onConflict: "brand_id,provider" })
    .select("id, provider, status, account_identifier, last_synced_at, last_error_message")
    .single();
  if (error) throw new Error(error.message);
  return data;
}

async function disconnectIntegration(admin: SupabaseClient, tenant: TenantContext, req: NextRequest) {
  const provider = req.nextUrl.searchParams.get("provider") || "";
  if (!PROVIDERS.has(provider)) throw new RouteError(400, "Unsupported integration provider");
  const { data, error } = await admin
    .from("integrations_integration")
    .update({ status: "disconnected", encrypted_credentials: null })
    .eq("brand_id", tenant.brand!.id)
    .eq("provider", provider)
    .select("id");
  if (error) throw new Error(error.message);
  if (!data?.length) throw new RouteError(404, "Integration not found");
  return { success: true };
}

/**
 * Calls a Supabase Edge Function AS THE USER: the function re-checks the JWT, workspace membership and
 * module access itself. (Never forward the service-role key: it carries no user, so the function's
 * requireAuth() rejects it, and it must not leave the server.)
 */
async function forwardToEdgeFunction(functionName: string, session: SessionContext, payload: Record<string, unknown>) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const functionsUrl = process.env.NEXT_PUBLIC_FUNCTIONS_URL || (supabaseUrl ? `${supabaseUrl}/functions/v1` : "");
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
  if (!functionsUrl || !anonKey) throw new RouteError(503, "Serverless functions URL is not configured");

  try {
    const res = await fetch(`${functionsUrl}/${functionName}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.accessToken}`,
        apikey: anonKey,
      },
      body: JSON.stringify(payload),
    });
    const json = await res.json().catch(() => null);
    if (!json) return NextResponse.json({ error: `${functionName} returned HTTP ${res.status}` }, { status: 502 });
    // Edge Functions answer { success, data | error }; the dashboard expects { message, ... } on success.
    if (res.ok && json.success !== false) return NextResponse.json(json.data ?? json, { status: res.status });
    return NextResponse.json({ error: json.error || `${functionName} failed`, details: json.details }, { status: res.status });
  } catch (err) {
    return NextResponse.json({ error: `Could not reach ${functionName}: ${(err as Error).message}` }, { status: 502 });
  }
}
