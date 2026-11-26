/**
 * PII minimisation for the raw ingestion layer.
 *
 * Raw payloads are kept so records can be audited and re-normalised, but customer contact data is
 * already held once in commerce_customer. Keeping a second copy in every raw payload (and in every
 * re-fetch of it) is the "unnecessary duplicate copy of sensitive customer information" to avoid.
 *
 * Rules (applied at any depth):
 *  - objects under ADDRESS_LIKE keys are replaced entirely;
 *  - `customer` objects keep only CUSTOMER_SAFE_KEYS (ids, timestamps, counters);
 *  - scalar values under SENSITIVE_KEYS are replaced;
 *  - everything else (ids, amounts, statuses, line items, discounts, refunds) is untouched.
 * The marker keeps the key present so "field existed" vs "field absent" is still visible.
 */
import { NOTE_ATTRIBUTE_ALLOWLIST } from "./mappers.ts";

export const REDACTED = "[redacted]";

const ADDRESS_LIKE = new Set([
  "billing_address", "shipping_address", "default_address", "addresses", "client_details",
  "customer_details", "card", "bank_account", "vpa_details", "upi",
]);
const SENSITIVE_KEYS = new Set([
  "email", "contact_email", "phone", "contact", "first_name", "last_name", "address1", "address2",
  "zip", "latitude", "longitude", "browser_ip", "vpa", "note", "customer_name", "customer_email",
  "customer_phone", "consignee", "consignee_address", "consignee_phone", "buyer_name",
]);
const CUSTOMER_SAFE_KEYS = new Set([
  "id", "admin_graphql_api_id", "created_at", "updated_at", "state", "orders_count", "total_spent",
  "currency", "verified_email", "tax_exempt", "tags",
]);

const ORDER_REF_NOTE = /order|receipt|invoice|reference|shopify/i;

export function redactPii(value: unknown): unknown {
  return walk(value);
}

function walk(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(walk);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const key = k.toLowerCase();
    if (ADDRESS_LIKE.has(key)) {
      out[k] = v === null ? null : REDACTED;
    } else if (key === "customer" && v && typeof v === "object" && !Array.isArray(v)) {
      const safe: Record<string, unknown> = {};
      for (const [ck, cv] of Object.entries(v as Record<string, unknown>)) {
        safe[ck] = CUSTOMER_SAFE_KEYS.has(ck.toLowerCase()) ? cv : (cv === null ? null : REDACTED);
      }
      out[k] = safe;
    } else if ((key === "note_attributes" || key === "customattributes") && Array.isArray(v)) {
      // [{name|key, value}] written by checkout apps: the attribute NAME says what the value is
      // (IP addresses, free-text notes with phone numbers...). Keep allow-listed attribution keys only.
      out[k] = v.map((a: any) => {
        const name = String(a?.name ?? a?.key ?? "");
        return NOTE_ATTRIBUTE_ALLOWLIST.has(name) ? a : { ...a, value: a?.value === null ? null : REDACTED };
      });
    } else if (key === "notes" && v && typeof v === "object" && !Array.isArray(v)) {
      // Razorpay notes are free-form merchant fields (often name/address): keep only order references.
      const kept: Record<string, unknown> = {};
      for (const [nk, nv] of Object.entries(v as Record<string, unknown>)) {
        kept[nk] = ORDER_REF_NOTE.test(nk) ? nv : REDACTED;
      }
      out[k] = kept;
    } else if (SENSITIVE_KEYS.has(key) && (typeof v === "string" || typeof v === "number")) {
      out[k] = v === "" ? "" : REDACTED;
    } else {
      out[k] = walk(v);
    }
  }
  return out;
}

/** Deterministic JSON (sorted keys at every level) so equal payloads hash equally. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}
