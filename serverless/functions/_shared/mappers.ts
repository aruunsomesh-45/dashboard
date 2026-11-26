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

/** Like toMinor, but missing / unparseable input is NULL (unknown), never a fabricated 0. */
export function toMinorOrNull(value: unknown, decimals = 2): number | null {
  if (value === null || value === undefined) return null;
  const s = (typeof value === "number" ? value.toFixed(decimals + 2) : String(value)).replace(/,/g, "").trim();
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(s)) return null;
  return toMinor(s, decimals);
}

/** Non-negative integer metric, or NULL when the platform did not provide it. */
export function intOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null;
}

export function decimalOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const ISO_CURRENCY = /^[A-Z]{3}$/;

/** ISO-4217 code (upper-cased). Anything else is passed through upper-cased so data quality can flag it. */
export function normalizeCurrency(value: unknown, fallback = "INR"): string {
  const c = String(value ?? "").trim().toUpperCase();
  if (!c) return fallback;
  return ISO_CURRENCY.test(c) ? c : c.slice(0, 3);
}

export function isIsoCurrency(value: unknown): boolean {
  return ISO_CURRENCY.test(String(value ?? ""));
}

/**
 * Courier APIs (e.g. Delhivery) return local wall-clock time without an offset. Interpret such
 * values in `assumedOffset` (IST by default) and return UTC ISO; values with an offset are kept.
 */
export function localToUtcIso(value: unknown, assumedOffset = "+05:30"): string | null {
  if (!value) return null;
  let s = String(value).trim().replace(" ", "T");
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s += "T00:00:00";
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) s += assumedOffset;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export interface Attribution {
  landing_path: string | null;
  referring_domain: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
}

/**
 * Extracts UTM parameters from a landing URL (absolute or relative). Only the path and the three
 * UTM values are kept: other query parameters can carry personal data (emails, tokens).
 * UTM values are trimmed + lower-cased so "Instagram" and "instagram" are one source.
 */
export function parseAttribution(landingSite: unknown, referringSite: unknown): Attribution {
  const out: Attribution = { landing_path: null, referring_domain: null, utm_source: null, utm_medium: null, utm_campaign: null };
  const landing = String(landingSite ?? "").trim();
  if (landing) {
    try {
      const u = new URL(landing, "https://landing.invalid");
      out.landing_path = u.pathname.slice(0, 500);
      const pick = (k: string) => {
        const v = u.searchParams.get(k)?.trim().toLowerCase();
        return v ? v.slice(0, 255) : null;
      };
      out.utm_source = pick("utm_source");
      out.utm_medium = pick("utm_medium");
      out.utm_campaign = pick("utm_campaign");
    } catch { /* unparseable landing URL: attribution stays unknown */ }
  }
  const referring = String(referringSite ?? "").trim();
  if (referring) {
    try {
      out.referring_domain = new URL(referring.includes("://") ? referring : `https://${referring}`).hostname.toLowerCase().slice(0, 255) || null;
    } catch { /* ignore */ }
  }
  return out;
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
    // Phase 3: original platform values + fields needed for reconciliation and attribution.
    subtotal_amount: toMinorOrNull(o.subtotal_price),
    refunded_amount: shopifyRefundedTotal(o),
    taxes_included: typeof o.taxes_included === "boolean" ? o.taxes_included : null,
    source_financial_status: str(o.financial_status, 50).toLowerCase(),
    source_fulfillment_status: str(o.fulfillment_status, 50).toLowerCase(),
    source_name: str(o.source_name, 100),
    cancel_reason: str(o.cancel_reason, 50),
    payment_gateways: Array.isArray(o.payment_gateway_names) ? o.payment_gateway_names.map((g: unknown) => str(g, 100)) : [],
    ...parseAttribution(o.landing_site, o.referring_site),
    ...checkoutIdentifiers(o),
  };
}

/**
 * Order note attributes (REST `note_attributes` [{name,value}] or GraphQL `customAttributes` [{key,value}])
 * reduced to an ALLOW-LIST. Checkout apps also write personal data here (e.g. Magic Checkout's
 * `Device_details_IP`, free-text "Additional Notes" with phone numbers); those keys are never read.
 */
export const NOTE_ATTRIBUTE_ALLOWLIST = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "utm_id",
  "fbclid", "gclid", "wbraid", "gbraid", "ttclid",
  "rzp_3p_utm", "rzp_3p_utm_ts", "rzp_device_id",
  "cart_token", "razorpay_payment_id", "razorpay_order_id",
]);

export function allowedNoteAttributes(o: any): Record<string, string> {
  const list = Array.isArray(o?.note_attributes) ? o.note_attributes : Array.isArray(o?.customAttributes) ? o.customAttributes : [];
  const out: Record<string, string> = {};
  for (const a of list) {
    const key = String(a?.name ?? a?.key ?? "").trim();
    if (NOTE_ATTRIBUTE_ALLOWLIST.has(key) && a?.value !== null && a?.value !== undefined) out[key] = String(a.value).trim().slice(0, 1000);
  }
  return out;
}

/** Parses Magic Checkout's `rzp_3p_utm` ("utm_source:ig||utm_medium:social||utm_id:...") into a map. */
export function parseRzpUtm(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of String(v ?? "").split("||")) {
    const i = part.indexOf(":");
    if (i <= 0) continue;
    const k = part.slice(0, i).trim().toLowerCase();
    const val = part.slice(i + 1).trim();
    if (/^utm_(source|medium|campaign|content|term|id)$/.test(k) && val) out[k] = val.slice(0, 255);
  }
  return out;
}

/** UTM value hygiene: trimmed, lower-cased, control characters removed, max 255. Empty -> null. */
export function cleanUtm(v: unknown): string | null {
  const s = String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().toLowerCase().slice(0, 255);
  return s ? s : null;
}

/** `rzp_device_id` = "1.<hash>.<first-seen epoch ms>.<random>": the first-seen time tells new from returning. */
export function deviceFirstSeen(deviceRef: unknown): string | null {
  const ms = Number(String(deviceRef ?? "").split(".")[2]);
  return Number.isFinite(ms) && ms > 1_500_000_000_000 && ms < 4_000_000_000_000 ? new Date(ms).toISOString() : null;
}

/**
 * Order-level touchpoints (no browser data needed):
 *  - checkout_capture: attribution the checkout app captured on the storefront and wrote to the order
 *    (prefers rzp_3p_utm, which also carries utm_id = our tracking-link code). Only created when the
 *    order actually carries campaign data or a click id; absence is "unknown", never "direct".
 *  - storefront_landing: Shopify's own landing_site / referring_site (native checkout orders).
 */
export function mapOrderTouchpoints(o: any, ctx: TenantCtx, orderId: string) {
  const a = allowedNoteAttributes(o);
  const rzp = parseRzpUtm(a.rzp_3p_utm);
  const pick = (k: string) => cleanUtm(rzp[k] ?? a[k]);
  const created = isoOrNull(o?.created_at);
  const tsMs = Number(a.rzp_3p_utm_ts);
  const out: Record<string, unknown>[] = [];
  const hasCampaign = ["utm_source", "utm_medium", "utm_campaign"].some((k) => pick(k)) || a.fbclid || a.gclid || a.gbraid || a.wbraid;
  if (hasCampaign && (created || Number.isFinite(tsMs))) {
    out.push({
      workspace_id: ctx.workspace_id,
      brand_id: ctx.brand_id,
      touch_type: "checkout_capture",
      order_id: orderId,
      occurred_at: Number.isFinite(tsMs) && tsMs > 1_500_000_000_000 ? new Date(tsMs).toISOString() : created,
      utm_source: pick("utm_source"),
      utm_medium: pick("utm_medium"),
      utm_campaign: pick("utm_campaign"),
      utm_content: pick("utm_content"),
      utm_term: pick("utm_term"),
      utm_id: pick("utm_id"),
      has_fbclid: Boolean(a.fbclid),
      has_gclid: Boolean(a.gclid || a.gbraid || a.wbraid),
      device_ref: a.rzp_device_id ? a.rzp_device_id.slice(0, 150) : null,
      device_first_seen_at: deviceFirstSeen(a.rzp_device_id),
    });
  }
  const landing = parseAttribution(o?.landing_site, o?.referring_site);
  if ((landing.landing_path || landing.referring_domain) && created) {
    const q = (() => {
      try {
        return new URL(String(o.landing_site), "https://landing.invalid").searchParams;
      } catch {
        return new URLSearchParams();
      }
    })();
    out.push({
      workspace_id: ctx.workspace_id,
      brand_id: ctx.brand_id,
      touch_type: "storefront_landing",
      order_id: orderId,
      occurred_at: created,
      utm_source: landing.utm_source,
      utm_medium: landing.utm_medium,
      utm_campaign: landing.utm_campaign,
      utm_content: cleanUtm(q.get("utm_content")),
      utm_term: cleanUtm(q.get("utm_term")),
      utm_id: cleanUtm(q.get("utm_id")),
      has_fbclid: q.has("fbclid"),
      has_gclid: q.has("gclid") || q.has("gbraid") || q.has("wbraid"),
      landing_path: landing.landing_path,
      referrer_domain: landing.referring_domain,
    });
  }
  return out;
}

/** Shopify cart token without its `?key=` secret (the key authorises cart access; it is never stored). */
export function cartTokenOnly(v: unknown): string {
  const t = String(v ?? "").split("?")[0].trim();
  return /^[A-Za-z0-9_-]{8,100}$/.test(t) ? t : "";
}

function checkoutIdentifiers(o: any) {
  const a = allowedNoteAttributes(o);
  const id = (v: string | undefined, re: RegExp) => (v && re.test(v) ? v : "");
  return {
    gateway_payment_ref: id(a.razorpay_payment_id, /^pay_[A-Za-z0-9]{6,40}$/),
    gateway_order_ref: id(a.razorpay_order_id, /^order_[A-Za-z0-9]{6,40}$/),
    checkout_cart_token: cartTokenOnly(a.cart_token ?? o?.cart_token),
  };
}

/** Successful refund money on a Shopify order (minor units); NULL when the payload carries no refund data. */
export function shopifyRefundedTotal(o: any): number | null {
  if (!Array.isArray(o?.refunds)) return null;
  return o.refunds.reduce((sum: number, r: any) => sum + (mapShopifyRefundAmount(r) ?? 0), 0);
}

function mapShopifyRefundAmount(r: any): number | null {
  if (!Array.isArray(r?.transactions)) return null;
  return r.transactions
    .filter((t: any) => String(t?.kind) === "refund" && String(t?.status) === "success")
    .reduce((sum: number, t: any) => sum + nonNegative(toMinor(t?.amount)), 0);
}

/** One Shopify refund object (order.refunds[] or the refunds/create webhook) -> commerce_refund row. */
export function mapShopifyRefund(r: any, ctx: TenantCtx, orderProviderId: string, currency: string) {
  if (!r || r.id === undefined || r.id === null) throw new Error("Shopify refund payload is missing 'id'");
  const txs = Array.isArray(r.transactions) ? r.transactions.filter((t: any) => String(t?.kind) === "refund") : [];
  const statuses = txs.map((t: any) => String(t?.status ?? "").toLowerCase());
  const status = txs.length === 0 || statuses.includes("success") ? "processed" : statuses.includes("pending") ? "pending" : "failed";
  return {
    workspace_id: ctx.workspace_id,
    brand_id: ctx.brand_id,
    provider: "shopify",
    provider_id: String(r.id),
    order_provider_id: String(r.order_id ?? orderProviderId),
    amount_minor: mapShopifyRefundAmount(r) ?? 0,
    currency: normalizeCurrency(currency),
    status,
    source_status: [...new Set(statuses)].join(",").slice(0, 50),
    source_created_at: isoOrNull(r.processed_at ?? r.created_at),
  };
}

export function mapShopifyRefunds(o: any, ctx: TenantCtx) {
  if (!Array.isArray(o?.refunds)) return [];
  return o.refunds.filter((r: any) => r?.id !== undefined && r?.id !== null)
    .map((r: any) => mapShopifyRefund(r, ctx, String(o.id), o.currency || "INR"));
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
    provider_line_id: str(li?.id, 255),
    provider_product_id: str(li?.product_id, 255),
    provider_variant_id: str(li?.variant_id, 255),
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
    source_created_at: epochToIso(created),
    source_status: str(p.status, 50).toLowerCase(),
    refunded_amount_minor: intOrNull(p.amount_refunded),
    refund_status: p.refund_status === "partial" || p.refund_status === "full" ? p.refund_status : null,
    ...razorpayOrderRef(p.notes),
  };
}

function epochToIso(seconds: number): string | null {
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null;
}

/**
 * Notes keys that may carry the merchant's (Shopify) order reference, most specific first.
 * The value is only used for EXACT matching against an order id/number of the same brand.
 */
const ORDER_REF_KEYS = ["shopify_order_id", "shopify_order_number", "shopify_order_name", "merchant_order_id", "order_id", "order_number", "receipt"];
const ORDER_REF_VALUE = /^#?[A-Za-z0-9_-]{1,64}$/;

export function razorpayOrderRef(notes: unknown): { merchant_order_ref: string; merchant_order_ref_key: string } {
  if (notes && typeof notes === "object" && !Array.isArray(notes)) {
    const n = notes as Record<string, unknown>;
    for (const key of ORDER_REF_KEYS) {
      const v = String(n[key] ?? "").trim();
      if (v && ORDER_REF_VALUE.test(v)) return { merchant_order_ref: v, merchant_order_ref_key: key };
    }
  }
  return { merchant_order_ref: "", merchant_order_ref_key: "" };
}

const REFUND_STATUS: Record<string, string> = { pending: "pending", created: "pending", processed: "processed", failed: "failed" };

/** Razorpay refund entity -> commerce_refund row (linked to its payment by payment id). */
export function mapRazorpayRefund(r: any, ctx: TenantCtx) {
  if (!r || typeof r.id !== "string" || !r.id) throw new Error("Razorpay refund entity is missing 'id'");
  const source = String(r.status ?? "").toLowerCase();
  return {
    workspace_id: ctx.workspace_id,
    brand_id: ctx.brand_id,
    provider: "razorpay",
    provider_id: r.id,
    payment_provider_id: str(r.payment_id, 255),
    amount_minor: nonNegative(intOrNull(r.amount) ?? 0),
    currency: normalizeCurrency(r.currency),
    status: REFUND_STATUS[source] ?? "pending",
    source_status: source.slice(0, 50),
    source_created_at: epochToIso(Number(r.created_at)),
  };
}

// ─── Delhivery ─────────────────────────────────────────────────────────────────
// Built against Delhivery's documented tracking response
// (ShipmentData[].Shipment{AWB, ReferenceNo, Status{Status,StatusType,StatusDateTime}, Scans[].ScanDetail}).
// No Delhivery connector exists yet: verify against a real response before relying on it.

/** Canonical shipment status from Delhivery StatusType (UD/DL/RT/PP/PU/CN) + status text. */
export function normalizeDelhiveryStatus(statusType: unknown, status: unknown): string {
  const t = String(statusType ?? "").toUpperCase();
  const s = String(status ?? "").toLowerCase().trim();
  if (t === "CN" || s.includes("cancel")) return "cancelled";
  if (t === "RT" || s.startsWith("rto") || s.includes("return")) {
    if (s.includes("delivered") || s === "returned" || s.includes("returned to")) return "rto_delivered";
    if (s.includes("initiated")) return "rto_initiated";
    return "rto_in_transit";
  }
  if (t === "DL" || s === "delivered") return "delivered";
  if (s.includes("out for delivery") || s === "dispatched") return "out_for_delivery";
  if (s.includes("undelivered") || s.includes("not delivered") || s.includes("ndr")) return "ndr";
  if (s.includes("picked up") || t === "PU") return "picked_up";
  if (s.includes("manifested") || s.includes("not picked") || s.includes("pickup") || t === "PP") return "pickup_pending";
  if (s.includes("in transit") || s === "pending" || s.includes("reached") || s.includes("bagged")) return "in_transit";
  return "unknown";
}

export function mapDelhiveryShipment(shipment: any, ctx: TenantCtx) {
  const awb = str(shipment?.AWB ?? shipment?.Waybill, 100);
  if (!awb) throw new Error("Delhivery shipment is missing AWB");
  const st = shipment?.Status ?? {};
  const canonical = normalizeDelhiveryStatus(st.StatusType, st.Status);
  const events = (Array.isArray(shipment?.Scans) ? shipment.Scans : [])
    .map((s: any) => s?.ScanDetail ?? s)
    .map((d: any) => ({
      occurred_at: localToUtcIso(d?.ScanDateTime ?? d?.StatusDateTime),
      location: str(d?.ScannedLocation ?? d?.StatusLocation, 255),
      status_description: str(d?.Instructions || d?.Scan || d?.Status || "scan", 2000),
      raw_status: str(d?.Scan ?? d?.Status, 100),
      source_code: str(d?.StatusCode ?? d?.ScanType, 50),
      canonical_status: normalizeDelhiveryStatus(d?.ScanType, d?.Scan ?? d?.Status),
    }))
    .filter((e: any) => e.occurred_at)
    .sort((a: any, b: any) => a.occurred_at.localeCompare(b.occurred_at));
  const first = (pred: (c: string) => boolean) => events.find((e: any) => pred(e.canonical_status))?.occurred_at ?? null;
  const isReturn = canonical.startsWith("rto");
  return {
    shipment: {
      workspace_id: ctx.workspace_id,
      brand_id: ctx.brand_id,
      provider: "delhivery",
      provider_id: awb,
      awb,
      courier_name: "Delhivery",
      canonical_status: canonical,
      raw_status: str(st.Status, 100),
      order_ref: str(shipment?.ReferenceNo, 255),
      picked_up_at: localToUtcIso(shipment?.PickUpDate) ?? first((c) => c === "picked_up"),
      shipped_at: first((c) => c === "in_transit"),
      delivered_at: canonical === "delivered" ? localToUtcIso(st.StatusDateTime) ?? first((c) => c === "delivered") : null,
      last_tracking_at: events.length ? events[events.length - 1].occurred_at : localToUtcIso(st.StatusDateTime),
      return_status: isReturn ? canonical : null,
      ndr_count: events.filter((e: any) => e.canonical_status === "ndr").length,
      payment_mode: shipment?.OrderType ? str(shipment.OrderType, 20).toLowerCase() : null,
      source_updated_at: localToUtcIso(st.StatusDateTime),
    },
    events,
  };
}

// ─── Meta Ads (ad level) ──────────────────────────────────────────────────────────

/** Largest value among overlapping purchase action types; NULL when the field was not returned. */
function purchaseMetric(list: unknown, parse: (v: unknown) => number | null): number | null {
  if (!Array.isArray(list)) return null;
  let best: number | null = null;
  for (const a of list) {
    if (PURCHASE_ACTIONS_SET.has((a as any)?.action_type)) {
      const v = parse((a as any)?.value);
      if (v !== null) best = best === null ? v : Math.max(best, v);
    }
  }
  return best ?? 0; // the list was returned and holds no purchase action: a real zero
}

const PURCHASE_ACTIONS_SET = new Set(["purchase", "omni_purchase", "offsite_conversion.fb_pixel_purchase"]);

/** One Graph /insights row requested with level=ad -> analytics_meta_ad_daily. Missing metrics stay NULL. */
export function mapMetaAdInsightDay(item: any, ctx: TenantCtx, opts: { adAccountId: string; currency: string; attributionSetting?: string }) {
  if (!item?.date_start || !/^\d{4}-\d{2}-\d{2}$/.test(item.date_start)) throw new Error("Meta insights row is missing a valid date_start");
  if (!item?.ad_id) throw new Error("Meta ad-level insights row is missing ad_id");
  return {
    workspace_id: ctx.workspace_id,
    brand_id: ctx.brand_id,
    ad_account_id: str(opts.adAccountId, 50),
    campaign_id: str(item.campaign_id, 50),
    campaign_name: str(item.campaign_name, 500),
    adset_id: str(item.adset_id, 50),
    adset_name: str(item.adset_name, 500),
    ad_id: str(item.ad_id, 50),
    ad_name: str(item.ad_name, 500),
    report_date: item.date_start,
    attribution_setting: str(opts.attributionSetting || item.attribution_setting || "account_default", 100),
    currency: normalizeCurrency(opts.currency),
    spend_minor: toMinorOrNull(item.spend),
    impressions: intOrNull(item.impressions),
    reach: intOrNull(item.reach),
    clicks: intOrNull(item.clicks),
    purchases: "actions" in (item ?? {}) ? purchaseMetric(item.actions, intOrNull) : null,
    purchase_value_minor: "action_values" in (item ?? {}) ? purchaseMetric(item.action_values, toMinorOrNull) : null,
    meta_cpm: decimalOrNull(item.cpm),
    meta_cpc: decimalOrNull(item.cpc),
    meta_ctr: decimalOrNull(item.ctr),
    source_metrics: Object.fromEntries(
      ["spend", "impressions", "reach", "clicks", "cpm", "cpc", "ctr", "actions", "action_values"]
        .filter((k) => k in item).map((k) => [k, item[k]]),
    ),
    fetched_at: new Date().toISOString(),
  };
}

// ─── Instagram (organic) ──────────────────────────────────────────────────────────

export function mapInstagramMedia(m: any, ctx: TenantCtx, igAccountId: string) {
  if (!m?.id) throw new Error("Instagram media is missing id");
  return {
    workspace_id: ctx.workspace_id,
    brand_id: ctx.brand_id,
    ig_account_id: str(igAccountId, 50),
    media_id: str(m.id, 50),
    media_type: str(m.media_type, 30),
    media_product_type: str(m.media_product_type, 30),
    permalink: str(m.permalink, 500),
    published_at: isoOrNull(m.timestamp),
  };
}

/** Insight value from either `values[0].value` or `total_value.value` (both shapes exist in Graph). */
function insightValue(data: unknown, name: string): number | null {
  if (!Array.isArray(data)) return null;
  const row = data.find((d: any) => d?.name === name);
  if (!row) return null;
  return intOrNull(row?.total_value?.value ?? row?.values?.[0]?.value);
}

/** Lifetime counters for one media on one date. Metrics Meta did not return stay NULL. */
export function mapInstagramSnapshot(media: any, insights: any, ctx: TenantCtx, snapshotDate: string) {
  if (!media?.id) throw new Error("Instagram media is missing id");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(snapshotDate)) throw new Error("snapshotDate must be YYYY-MM-DD");
  const data = insights?.data;
  return {
    workspace_id: ctx.workspace_id,
    brand_id: ctx.brand_id,
    media_id: str(media.id, 50),
    snapshot_date: snapshotDate,
    reach: insightValue(data, "reach"),
    impressions: insightValue(data, "impressions"),
    views: insightValue(data, "views"),
    likes: intOrNull(media.like_count) ?? insightValue(data, "likes"),
    comments: intOrNull(media.comments_count) ?? insightValue(data, "comments"),
    shares: insightValue(data, "shares"),
    saves: insightValue(data, "saved"),
    total_interactions: insightValue(data, "total_interactions"),
    source_metrics: { insights: Array.isArray(data) ? data : null, like_count: media.like_count ?? null, comments_count: media.comments_count ?? null },
    fetched_at: new Date().toISOString(),
  };
}

// ─── Google Analytics 4 (Data API runReport) ──────────────────────────────────────

const GA4_NOT_SET = "(not set)";

function ga4Date(v: unknown): string {
  const s = String(v ?? "");
  if (!/^\d{8}$/.test(s)) throw new Error(`GA4 date dimension must be YYYYMMDD, got '${s}'`);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

/** Turns one runReport row into {dimension: value} / {metric: value} maps using the response headers. */
export function ga4RowToRecord(report: any, row: any): { dims: Record<string, string>; metrics: Record<string, string | undefined> } {
  const dims: Record<string, string> = {};
  const metrics: Record<string, string | undefined> = {};
  (report?.dimensionHeaders ?? []).forEach((h: any, i: number) => (dims[h.name] = row?.dimensionValues?.[i]?.value ?? GA4_NOT_SET));
  (report?.metricHeaders ?? []).forEach((h: any, i: number) => (metrics[h.name] = row?.metricValues?.[i]?.value));
  return { dims, metrics };
}

/** Dimensions are kept verbatim (incl. "(not set)"); metrics GA4 did not return stay NULL. */
export function mapGa4DailyRow(report: any, row: any, ctx: TenantCtx, propertyId: string, currency: string) {
  const { dims, metrics } = ga4RowToRecord(report, row);
  const d = (k: string, max: number) => (dims[k] ?? GA4_NOT_SET).slice(0, max);
  return {
    workspace_id: ctx.workspace_id,
    brand_id: ctx.brand_id,
    property_id: str(propertyId, 30),
    report_date: ga4Date(dims.date),
    session_source: d("sessionSource", 255),
    session_medium: d("sessionMedium", 255),
    session_campaign: d("sessionCampaignName", 255),
    landing_page: d("landingPage", 1000),
    device_category: d("deviceCategory", 30),
    sessions: intOrNull(metrics.sessions),
    total_users: intOrNull(metrics.totalUsers),
    new_users: intOrNull(metrics.newUsers),
    screen_page_views: intOrNull(metrics.screenPageViews),
    key_events: decimalOrNull(metrics.keyEvents ?? metrics.conversions),
    transactions: intOrNull(metrics.transactions),
    purchase_revenue_minor: toMinorOrNull(metrics.purchaseRevenue),
    currency: normalizeCurrency(currency),
    fetched_at: new Date().toISOString(),
  };
}

export function mapGa4TransactionRow(report: any, row: any, ctx: TenantCtx, propertyId: string, currency: string) {
  const { dims, metrics } = ga4RowToRecord(report, row);
  const tx = (dims.transactionId ?? "").trim();
  if (!tx || tx === GA4_NOT_SET) return null; // GA4 rows without a transaction id cannot be reconciled
  return {
    workspace_id: ctx.workspace_id,
    brand_id: ctx.brand_id,
    property_id: str(propertyId, 30),
    transaction_id: tx.slice(0, 255),
    report_date: ga4Date(dims.date),
    session_source: (dims.sessionSource ?? GA4_NOT_SET).slice(0, 255),
    session_medium: (dims.sessionMedium ?? GA4_NOT_SET).slice(0, 255),
    session_campaign: (dims.sessionCampaignName ?? GA4_NOT_SET).slice(0, 255),
    purchase_revenue_minor: toMinorOrNull(metrics.purchaseRevenue),
    currency: normalizeCurrency(currency),
    fetched_at: new Date().toISOString(),
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
