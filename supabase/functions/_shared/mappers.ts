/**
 * Pure normalisers: third-party payloads -> rows that match the LIVE Supabase schema
 * (supabase/migrations, verified against the hosted project's PostgREST column set).
 *
 * Canonical commerce tables key rows on (brand_id, provider, provider_id); money is stored
 * in minor units (paise) in BIGINT columns named gross_amount / net_sales / amount_minor etc.
 */
import { HttpError } from "./http.ts";

export interface TenantCtx {
  workspace_id: string;
  brand_id: string;
}

// ─── Money ────────────────────────────────────────────────────────────────────

/**
 * Converts a decimal amount ("199.99", 199.99, "1,299.50") into integer minor units without
 * binary floating-point drift. Invalid / empty input yields 0.
 */
export function toMinor(value: unknown, decimals = 2): number {
  if (value === null || value === undefined) return 0;
  let s = typeof value === "number" ? value.toFixed(decimals + 2) : String(value);
  s = s.replace(/,/g, "").trim();
  const m = s.match(/^(-?)(\d*)(?:\.(\d*))?$/);
  if (!m || (m[2] === "" && (m[3] ?? "") === "")) return 0;
  const sign = m[1] === "-" ? -1 : 1;
  const whole = m[2] || "0";
  const frac = (m[3] ?? "").padEnd(decimals + 1, "0");
  let minor = Number(whole) * 10 ** decimals + Number(frac.slice(0, decimals) || "0");
  if (Number(frac[decimals]) >= 5) minor += 1; // round half up
  return sign * minor;
}

function nonNegative(n: number): number {
  return n < 0 ? 0 : n;
}

function str(v: unknown, max: number, def = ""): string {
  if (v === null || v === undefined) return def;
  return String(v).slice(0, max);
}

function isoOrNull(v: unknown): string | null {
  if (!v) return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// ─── Shopify ──────────────────────────────────────────────────────────────────

const SHOP_DOMAIN_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

/**
 * Normalises a store reference to "<store>.myshopify.com". Anything else is rejected so the
 * functions can never be used to send an Admin API token to an arbitrary host (SSRF).
 */
export function normalizeShopDomain(input: unknown): string {
  let d = String(input ?? "").trim().toLowerCase();
  d = d.replace(/^https?:\/\//, "").split(/[/?#]/)[0];
  if (d && !d.includes(".")) d = `${d}.myshopify.com`;
  if (!SHOP_DOMAIN_RE.test(d)) {
    throw new HttpError(400, "Shop domain must be a <store>.myshopify.com address.");
  }
  return d;
}

const ORDER_FINANCIAL: Record<string, string> = {
  pending: "pending",
  authorized: "pending", // authorised but not captured — schema has no 'authorized' order state
  partially_paid: "pending",
  paid: "paid",
  partially_refunded: "partially_refunded",
  refunded: "refunded",
  voided: "voided",
  expired: "voided",
};

/** Maps Shopify financial_status onto chk_commerce_order_financial_status. */
export function normalizeShopifyFinancialStatus(s: unknown): string {
  return ORDER_FINANCIAL[String(s ?? "").toLowerCase()] ?? "pending";
}

const ORDER_FULFILLMENT = new Set(["unfulfilled", "partial", "fulfilled", "restocked"]);

/** Maps Shopify fulfillment_status (null = unfulfilled) onto chk_commerce_order_fulfillment_status. */
export function normalizeShopifyFulfillmentStatus(s: unknown): string {
  const v = String(s ?? "").toLowerCase();
  return ORDER_FULFILLMENT.has(v) ? v : "unfulfilled";
}

export function mapShopifyCustomer(c: any, ctx: TenantCtx) {
  if (!c || c.id === undefined || c.id === null) return null;
  return {
    workspace_id: ctx.workspace_id,
    brand_id: ctx.brand_id,
    provider: "shopify",
    provider_id: String(c.id),
    first_name: str(c.first_name, 150),
    last_name: str(c.last_name, 150),
    email: str(c.email, 254).toLowerCase().trim(),
    phone: str(c.phone, 30),
    source_created_at: isoOrNull(c.created_at),
    source_updated_at: isoOrNull(c.updated_at),
  };
}

export function mapShopifyOrder(o: any, ctx: TenantCtx, customerId: string | null = null) {
  if (!o || o.id === undefined || o.id === null) {
    throw new Error("Shopify order payload is missing 'id'");
  }
  const gross = toMinor(o.total_price);
  const discount = toMinor(o.total_discounts);
  const tax = toMinor(o.total_tax);
  const shipping = Array.isArray(o.shipping_lines)
    ? o.shipping_lines.reduce((acc: number, l: any) => acc + toMinor(l?.price), 0)
    : toMinor(o.total_shipping_price_set?.shop_money?.amount);
  return {
    workspace_id: ctx.workspace_id,
    brand_id: ctx.brand_id,
    provider: "shopify",
    provider_id: String(o.id),
    order_number: str(o.order_number ?? o.name ?? o.id, 100),
    customer_id: customerId,
    currency: str(o.currency || "INR", 3).toUpperCase(),
    gross_amount: gross,
    discount_amount: discount,
    tax_amount: tax,
    shipping_amount: shipping,
    // Shopify total_price is already net of discounts (it includes tax + shipping);
    // net sales = total_price - tax - shipping.
    net_sales: gross - tax - shipping,
    financial_status: normalizeShopifyFinancialStatus(o.financial_status),
    fulfillment_status: normalizeShopifyFulfillmentStatus(o.fulfillment_status),
    cancelled_at: isoOrNull(o.cancelled_at),
    source_created_at: isoOrNull(o.created_at),
    source_updated_at: isoOrNull(o.updated_at),
  };
}

export function mapShopifyLineItems(o: any, orderId: string) {
  if (!Array.isArray(o?.line_items)) return [];
  return o.line_items.map((li: any) => ({
    order_id: orderId,
    title: str(li?.title || li?.name || "Untitled item", 255),
    sku: str(li?.sku, 100),
    quantity: Math.max(1, Number.parseInt(String(li?.quantity ?? 1), 10) || 1),
    price_minor: nonNegative(toMinor(li?.price)),
    total_discount_minor: nonNegative(toMinor(li?.total_discount)),
  }));
}

/** Returns the rel="next" URL from a Shopify Link header, only if it stays on `expectedHost`. */
export function extractShopifyNextPageUrl(linkHeader: string | null, expectedHost?: string): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="?next"?/);
    if (m) {
      try {
        const u = new URL(m[1]);
        if (u.protocol !== "https:") return null;
        if (expectedHost && u.host !== expectedHost) return null;
        return u.toString();
      } catch {
        return null;
      }
    }
  }
  return null;
}

// ─── Razorpay ─────────────────────────────────────────────────────────────────

const PAYMENT_STATUS: Record<string, string> = {
  created: "authorized", // in-flight; schema has no 'created'/'pending' payment state
  authorized: "authorized",
  captured: "captured",
  failed: "failed",
  refunded: "refunded",
};

/** Maps Razorpay payment.status onto chk_commerce_payment_status. */
export function normalizeRazorpayStatus(s: unknown): string {
  return PAYMENT_STATUS[String(s ?? "").toLowerCase()] ?? "failed";
}

const PAYMENT_METHOD: Record<string, string> = {
  upi: "upi",
  card: "card",
  netbanking: "netbanking",
  wallet: "wallet",
  emi: "emi",
  cardless_emi: "emi",
};

/** Maps Razorpay payment.method onto chk_commerce_payment_method. */
export function normalizeRazorpayMethod(m: unknown): string {
  return PAYMENT_METHOD[String(m ?? "").toLowerCase()] ?? "other";
}

export function mapRazorpayPayment(p: any, ctx: TenantCtx) {
  if (!p || typeof p.id !== "string" || !p.id) {
    throw new Error("Razorpay payment entity is missing 'id'");
  }
  const amount = Number.isFinite(Number(p.amount)) ? Math.trunc(Number(p.amount)) : 0; // already in paise
  const created = Number(p.created_at);
  return {
    workspace_id: ctx.workspace_id,
    brand_id: ctx.brand_id,
    provider: "razorpay",
    provider_id: p.id,
    amount_minor: nonNegative(amount),
    currency: str(p.currency || "INR", 3).toUpperCase(),
    status: normalizeRazorpayStatus(p.status),
    method: normalizeRazorpayMethod(p.method),
    gateway_order_id: str(p.order_id, 255),
    error_code: str(p.error_code, 100),
    error_description: str(p.error_description, 2000),
    source_created_at: Number.isFinite(created) && created > 0 ? new Date(created * 1000).toISOString() : null,
  };
}

// ─── Meta Ads ─────────────────────────────────────────────────────────────────

export function normalizeMetaAdAccountId(input: unknown): string {
  let id = String(input ?? "").trim();
  if (!id) return "";
  if (!id.startsWith("act_")) id = `act_${id}`;
  if (!/^act_\d+$/.test(id)) throw new HttpError(400, "Meta ad account id must look like act_<digits>.");
  return id;
}

const PURCHASE_ACTIONS = new Set(["purchase", "omni_purchase", "offsite_conversion.fb_pixel_purchase"]);

/** Maps one Graph API /insights daily row onto analytics_factadsdaily. */
export function mapMetaInsightDay(item: any, ctx: TenantCtx) {
  if (!item?.date_start || !/^\d{4}-\d{2}-\d{2}$/.test(item.date_start)) {
    throw new Error("Meta insights row is missing a valid date_start");
  }
  let purchases = 0;
  let revenueMinor = 0;
  // The purchase action types overlap (omni_purchase ⊇ purchase), so take the max, never the sum.
  for (const a of Array.isArray(item.actions) ? item.actions : []) {
    if (PURCHASE_ACTIONS.has(a?.action_type)) purchases = Math.max(purchases, Number.parseInt(a.value, 10) || 0);
  }
  for (const av of Array.isArray(item.action_values) ? item.action_values : []) {
    if (PURCHASE_ACTIONS.has(av?.action_type)) revenueMinor = Math.max(revenueMinor, toMinor(av.value));
  }
  return {
    workspace_id: ctx.workspace_id,
    brand_id: ctx.brand_id,
    fact_date: item.date_start,
    spend_minor: nonNegative(toMinor(item.spend)),
    impressions: nonNegative(Number.parseInt(item.impressions ?? "0", 10) || 0),
    clicks: nonNegative(Number.parseInt(item.clicks ?? "0", 10) || 0),
    attributed_conversions: nonNegative(purchases),
    attributed_revenue_minor: nonNegative(revenueMinor),
  };
}

export type MetaErrorKind = "token_invalid" | "permission" | "rate_limit" | "invalid_request" | "unknown";

/** Classifies a Graph API error body: https://developers.facebook.com/docs/graph-api/guides/error-handling */
export function classifyMetaError(body: any): { kind: MetaErrorKind; message: string; code?: number } {
  const e = body?.error;
  if (!e) return { kind: "unknown", message: "Unknown Graph API error" };
  const code = Number(e.code);
  const message = String(e.message ?? "Graph API error");
  // 190 = invalid/expired access token (subcode 463 = expired, 460 = password changed); 102 = session key invalid
  if (code === 190 || code === 102) return { kind: "token_invalid", message, code };
  if (code === 10 || (code >= 200 && code < 300)) return { kind: "permission", message, code };
  if ([4, 17, 32, 613].includes(code) || (code >= 80000 && code <= 80014)) return { kind: "rate_limit", message, code };
  if (code === 100) return { kind: "invalid_request", message, code };
  return { kind: "unknown", message, code };
}
