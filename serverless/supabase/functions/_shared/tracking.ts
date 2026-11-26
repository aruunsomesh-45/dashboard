/**
 * Storefront tracking batch validation + normalisation (pure; used by the `track` Edge Function).
 *
 * Privacy rules enforced here, before anything reaches the database:
 *  - only paths are kept from URLs, plus the 5 UTM params, utm_id and ad click ids;
 *    every other query parameter (emails, tokens, search terms) is dropped;
 *  - referrers are reduced to a domain, and dropped when they are the store itself (internal navigation);
 *  - no IP address, user agent string, screen size or other fingerprinting data is accepted;
 *  - browser "purchase"/"payment"/"refund" events are refused: money comes only from verified records;
 *  - nothing is accepted without analytics consent.
 */
import { HttpError } from "./http.ts";
import { cartTokenOnly, cleanUtm, normalizeCurrency, toMinorOrNull } from "./mappers.ts";

export const MAX_BATCH_BYTES = 64 * 1024;
export const MAX_EVENTS = 50;
const PAST_TOLERANCE_MS = 7 * 86_400_000;
const FUTURE_TOLERANCE_MS = 5 * 60_000;

/** Events a browser may report. purchase / payment_* / refund / customer_return are server-derived only. */
export const CLIENT_EVENTS = new Set(["page_view", "landing_page_view", "product_view", "add_to_cart", "begin_checkout", "checkout_completed"]);
const CLICK_IDS = ["fbclid", "gclid", "wbraid", "gbraid", "ttclid"];
const ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const EVENT_ID_RE = /^[A-Za-z0-9_-]{8,80}$/;
const KEY_RE = /^pk_[A-Za-z0-9]{16,36}$/;
const DEVICES = new Set(["mobile", "tablet", "desktop"]);
const BROWSERS = new Set(["chrome", "safari", "firefox", "edge", "samsung", "opera", "instagram_inapp", "facebook_inapp", "other"]);

export interface NormalizedBatch {
  publicKey: string;
  batch: {
    consent: { analytics: boolean };
    visitor: { key: string };
    session: {
      key: string;
      started_at: string;
      landing_path: string;
      referrer_domain: string | null;
      utm: Record<string, string | null>;
      click_ids: Record<string, string>;
      device_category: string | null;
      browser_family: string | null;
    };
    events: Array<Record<string, unknown>>;
  };
}

function bad(msg: string): never {
  throw new HttpError(400, `Invalid tracking batch: ${msg}`);
}

function parseUrl(v: unknown): URL | null {
  if (typeof v !== "string" || !v || v.length > 4000) return null;
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:" ? u : null;
  } catch {
    return null;
  }
}

function toIso(v: unknown, now: number): string {
  const ms = typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : NaN;
  if (!Number.isFinite(ms) || ms < now - PAST_TOLERANCE_MS || ms > now + FUTURE_TOLERANCE_MS) return new Date(now).toISOString();
  return new Date(ms).toISOString();
}

/** Numeric Shopify id from a gid ("gid://shopify/ProductVariant/123") or digits. */
function shopifyNumericId(v: unknown): string | null {
  const m = String(v ?? "").match(/(\d{1,30})$/);
  return m ? m[1] : null;
}

export function normalizeTrackingBatch(body: unknown, now = Date.now()): NormalizedBatch {
  if (!body || typeof body !== "object" || Array.isArray(body)) bad("body must be an object");
  const b = body as Record<string, any>;
  if (typeof b.k !== "string" || !KEY_RE.test(b.k)) bad("site key");
  if (typeof b.visitor !== "string" || !ID_RE.test(b.visitor)) bad("visitor id");
  const s = b.session;
  if (!s || typeof s !== "object" || typeof s.id !== "string" || !ID_RE.test(s.id)) bad("session id");
  if (!Array.isArray(b.events) || b.events.length === 0 || b.events.length > MAX_EVENTS) bad(`events must be 1..${MAX_EVENTS}`);

  const landing = parseUrl(s.landing_url);
  const storeHost = landing?.hostname.toLowerCase() ?? null;
  const ref = parseUrl(s.referrer);
  const refHost = ref?.hostname.toLowerCase() ?? null;
  const external = refHost && refHost !== storeHost && !(storeHost && refHost.endsWith(`.${storeHost.replace(/^www\./, "")}`)) ? refHost : null;

  const params = landing?.searchParams ?? new URLSearchParams();
  const utm = {
    source: cleanUtm(params.get("utm_source")),
    medium: cleanUtm(params.get("utm_medium")),
    campaign: cleanUtm(params.get("utm_campaign")),
    content: cleanUtm(params.get("utm_content")),
    term: cleanUtm(params.get("utm_term")),
    id: cleanUtm(params.get("utm_id")),
  };
  const click_ids: Record<string, string> = {};
  for (const k of CLICK_IDS) {
    const v = params.get(k);
    if (v && /^[A-Za-z0-9_.\-]{4,500}$/.test(v)) click_ids[k] = v;
  }

  const seen = new Set<string>();
  const events = b.events.map((e: any, i: number) => {
    if (!e || typeof e !== "object") bad(`event ${i}`);
    if (typeof e.id !== "string" || !EVENT_ID_RE.test(e.id) || e.id.startsWith("srv")) bad(`event ${i} id`);
    if (!CLIENT_EVENTS.has(e.name)) bad(`event ${i} name '${String(e.name).slice(0, 40)}' is not accepted from browsers`);
    if (seen.has(e.id)) bad(`event ${i} id repeated in batch`);
    seen.add(e.id);
    const u = parseUrl(e.url);
    return {
      id: e.id,
      name: e.name,
      ts: toIso(e.ts, now),
      seq: Number.isInteger(e.seq) && e.seq >= 0 && e.seq < 1_000_000 ? e.seq : null,
      path: u ? u.pathname.slice(0, 500) : null,
      product_ref: e.product ? shopifyNumericId(e.product) : null,
      cart_token: e.cart ? cartTokenOnly(e.cart) || null : null,
      order_ref: e.name === "checkout_completed" && e.order ? shopifyNumericId(e.order) : null,
      value_minor: e.value !== undefined ? toMinorOrNull(e.value) : null,
      currency: e.currency ? normalizeCurrency(e.currency) : null,
    };
  });

  return {
    publicKey: b.k,
    batch: {
      consent: { analytics: b.consent?.analytics === true },
      visitor: { key: b.visitor },
      session: {
        key: s.id,
        started_at: toIso(s.started_at, now),
        landing_path: landing ? landing.pathname.slice(0, 500) : "/",
        referrer_domain: external ? external.slice(0, 255) : null,
        utm,
        click_ids,
        device_category: DEVICES.has(s.device) ? s.device : null,
        browser_family: BROWSERS.has(s.browser) ? s.browser : null,
      },
      events,
    },
  };
}
