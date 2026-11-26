/**
 * 125East storefront journey pixel — Shopify Custom Pixel (Settings → Customer events → Add custom pixel).
 *
 * NOT INSTALLED. Installing it on the live store is a production change that needs approval.
 * Recommended pixel settings: Permission = "Analytics" required; Data sale = "does not qualify".
 *
 * What it does
 *  - Captures the landing URL's utm_* / utm_id / ad click ids ONCE per session (never overwritten
 *    by internal navigation), the referrer domain, and journey events:
 *    page_view, landing_page_view, product_view, add_to_cart, begin_checkout, checkout_completed.
 *  - Reads Shopify's own `cart` cookie so a visitor can later be linked to the order that the checkout
 *    app (Razorpay Magic Checkout) creates from the same cart. No guessing, no email matching.
 *  - Uses Shopify's own event.id as the event id (globally unique -> duplicate-proof).
 *
 * What it does NOT do
 *  - No email/phone/name/address, no IP, no user-agent string, no fingerprinting.
 *  - Sends nothing and stores no identifier unless analytics consent is granted.
 *  - Does not duplicate Magic Checkout's order-level UTM capture; orders get that from the checkout app.
 *  - Browser events are never treated as revenue by the backend.
 *
 * Known limitation: Magic Checkout replaces Shopify checkout, so `checkout_started` /
 * `checkout_completed` only fire for orders placed through Shopify's native checkout.
 */
const ENDPOINT = "https://ybyroxyofqfpozvfedhc.supabase.co/functions/v1/track";
const SITE_KEY = "pk_REPLACE_WITH_SITE_KEY"; // public identifier from attribution_site.public_key
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
const VISITOR_KEY = "_e125_v";
const SESSION_KEY = "_e125_s";

let consentGranted = Boolean(init?.customerPrivacy?.analyticsProcessingAllowed);
const privacy = typeof customerPrivacy !== "undefined" ? customerPrivacy : (typeof api !== "undefined" ? api.customerPrivacy : null);
if (privacy?.subscribe) {
  privacy.subscribe("visitorConsentCollected", (e) => {
    consentGranted = Boolean(e?.customerPrivacy?.analyticsProcessingAllowed);
  });
}

function randomId(prefix) {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return prefix + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function campaignKey(url) {
  try {
    const p = new URL(url).searchParams;
    const k = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "utm_id", "fbclid", "gclid"]
      .map((n) => p.get(n) || "").join("|");
    return k.replace(/\|/g, "") ? k : "";
  } catch {
    return "";
  }
}

function deviceFamily(ua) {
  const s = String(ua || "").toLowerCase();
  return /ipad|tablet/.test(s) ? "tablet" : /mobi|android|iphone/.test(s) ? "mobile" : "desktop";
}

function browserFamily(ua) {
  const s = String(ua || "").toLowerCase();
  if (s.includes("instagram")) return "instagram_inapp";
  if (s.includes("fban") || s.includes("fbav")) return "facebook_inapp";
  if (s.includes("samsungbrowser")) return "samsung";
  if (s.includes("edg/")) return "edge";
  if (s.includes("opr/")) return "opera";
  if (s.includes("firefox")) return "firefox";
  if (s.includes("chrome")) return "chrome";
  if (s.includes("safari")) return "safari";
  return "other";
}

async function state(ctx) {
  const now = Date.now();
  let visitor = await browser.localStorage.getItem(VISITOR_KEY);
  if (!visitor) {
    visitor = randomId("v_");
    await browser.localStorage.setItem(VISITOR_KEY, visitor);
  }
  const href = ctx?.document?.location?.href || "";
  const campaign = campaignKey(href);
  let session = null;
  try { session = JSON.parse((await browser.localStorage.getItem(SESSION_KEY)) || "null"); } catch { session = null; }
  // New session after 30 min inactivity, or when the visitor arrives through a different campaign link.
  const isNew = !session || now - session.last > SESSION_TIMEOUT_MS || (campaign && campaign !== session.campaign);
  if (isNew) {
    session = {
      id: randomId("s_"), started: now, last: now, campaign, seq: 0,
      landing: href, referrer: ctx?.document?.referrer || "",
      device: deviceFamily(ctx?.navigator?.userAgent), browser: browserFamily(ctx?.navigator?.userAgent),
    };
  }
  session.last = now;
  session.seq += 1;
  await browser.localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  return { visitor, session, isNew };
}

async function cartToken() {
  try { return (await browser.cookie.get("cart")) || null; } catch { return null; }
}

async function send(name, event, extra) {
  if (!consentGranted || SITE_KEY.includes("REPLACE")) return;
  const { visitor, session, isNew } = await state(event.context);
  const base = { ts: Date.parse(event.timestamp) || Date.now(), url: event.context?.document?.location?.href, cart: await cartToken() };
  const events = [{ id: event.id, name, seq: session.seq, ...base, ...extra }];
  if (isNew && name === "page_view") events.push({ id: `${event.id}-l`, name: "landing_page_view", seq: session.seq, ...base });
  const body = JSON.stringify({
    k: SITE_KEY,
    consent: { analytics: true },
    visitor,
    session: { id: session.id, started_at: session.started, landing_url: session.landing, referrer: session.referrer, device: session.device, browser: session.browser },
    events,
  });
  try {
    await fetch(ENDPOINT, { method: "POST", headers: { "Content-Type": "text/plain" }, body, keepalive: true });
  } catch { /* tracking must never break the storefront */ }
}

analytics.subscribe("page_viewed", (e) => send("page_view", e, {}));
analytics.subscribe("product_viewed", (e) => send("product_view", e, { product: e.data?.productVariant?.id }));
analytics.subscribe("product_added_to_cart", (e) => send("add_to_cart", e, { product: e.data?.cartLine?.merchandise?.id }));
analytics.subscribe("checkout_started", (e) => send("begin_checkout", e, {}));
analytics.subscribe("checkout_completed", (e) => send("checkout_completed", e, { order: e.data?.checkout?.order?.id }));
