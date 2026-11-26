// Phase 4 unit tests: storefront batch validation, order touchpoints, link builder.
// [UNIT, synthetic inputs; value shapes mirror real Magic Checkout attributes seen read-only on 2026-11-23]
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import { normalizeTrackingBatch } from "../../supabase/functions/_shared/tracking.ts";
import { deviceFirstSeen, mapOrderTouchpoints, parseRzpUtm } from "../../supabase/functions/_shared/mappers.ts";
import { buildLink, LinkValidationError, newLinkCode, slugUtm } from "../../../frontend/src/lib/utmLinks.ts";
import { shopifyOrder } from "../helpers/payloads.ts";

const NOW = Date.parse("2026-11-23T10:00:00Z");
const ctx = { workspace_id: "00000000-0000-4000-8000-000000000001", brand_id: "00000000-0000-4000-8000-000000000002" };
const batch = (over: Record<string, unknown> = {}, session: Record<string, unknown> = {}, events?: unknown[]) => ({
  k: "pk_test0000000000000000",
  consent: { analytics: true },
  visitor: "v_aaaaaaaaaaaaaaaaaaaa",
  session: { id: "s_bbbbbbbbbbbbbbbbbbbb", started_at: NOW - 1000, landing_url: "https://125east.in/", referrer: "", device: "mobile", browser: "chrome", ...session },
  events: events ?? [{ id: "evt_00000001", name: "page_view", ts: NOW, seq: 1, url: "https://125east.in/" }],
  ...over,
});

Deno.test("UTM capture: all five + utm_id, cleaned; other query params dropped; click ids kept", () => {
  const n = normalizeTrackingBatch(batch({}, {
    landing_url: "https://125east.in/products/chrome-buds?utm_source=Instagram&utm_medium=Organic_Social&utm_campaign=Product%20Launch&utm_content=story_link_01&utm_term=buds&utm_id=l_abc12345&email=a%40b.c&fbclid=IwAR0abc_def&gclid=Cj0K-xyz",
  }), NOW);
  assertEquals(n.batch.session.utm, { source: "instagram", medium: "organic_social", campaign: "product launch", content: "story_link_01", term: "buds", id: "l_abc12345" });
  assertEquals(n.batch.session.click_ids, { fbclid: "IwAR0abc_def", gclid: "Cj0K-xyz" });
  assertEquals(n.batch.session.landing_path, "/products/chrome-buds");
  assert(!JSON.stringify(n).includes("a@b.c") && !JSON.stringify(n).includes("email"), "non-attribution params never stored");
});

Deno.test("UTM capture: missing parameters stay null (direct visit); control characters stripped", () => {
  const direct = normalizeTrackingBatch(batch(), NOW);
  assertEquals(Object.values(direct.batch.session.utm).every((v) => v === null), true);
  assertEquals(direct.batch.session.referrer_domain, null);
  const dirty = normalizeTrackingBatch(batch({}, { landing_url: "https://125east.in/?utm_source=%00ig%0A&utm_medium=%20%20" }), NOW);
  assertEquals([dirty.batch.session.utm.source, dirty.batch.session.utm.medium], ["ig", null]);
});

Deno.test("referrer: external kept as domain, the store itself (internal navigation) dropped", () => {
  assertEquals(normalizeTrackingBatch(batch({}, { referrer: "https://l.instagram.com/?u=xyz" }), NOW).batch.session.referrer_domain, "l.instagram.com");
  assertEquals(normalizeTrackingBatch(batch({}, { referrer: "https://125east.in/collections/all" }), NOW).batch.session.referrer_domain, null);
  assertEquals(normalizeTrackingBatch(batch({}, { landing_url: "https://www.125east.in/", referrer: "https://checkout.125east.in/" }), NOW).batch.session.referrer_domain, null);
});

Deno.test("events: browsers may not report money events or server ids; ids unique per batch; time clamped", () => {
  for (const name of ["purchase", "payment_success", "payment_failed", "refund", "customer_return", "bogus"]) {
    assertThrows(() => normalizeTrackingBatch(batch({}, {}, [{ id: "evt_00000001", name, ts: NOW }]), NOW), Error, "not accepted");
  }
  assertThrows(() => normalizeTrackingBatch(batch({}, {}, [{ id: "srv:order:x", name: "page_view" }]), NOW));
  assertThrows(() => normalizeTrackingBatch(batch({}, {}, [{ id: "evt_00000001", name: "page_view" }, { id: "evt_00000001", name: "page_view" }]), NOW));
  assertThrows(() => normalizeTrackingBatch(batch({}, {}, []), NOW));
  assertThrows(() => normalizeTrackingBatch(batch({}, {}, Array.from({ length: 51 }, (_, i) => ({ id: `evt_${String(i).padStart(8, "0")}`, name: "page_view" }))), NOW));
  const old = normalizeTrackingBatch(batch({}, {}, [{ id: "evt_00000001", name: "page_view", ts: NOW - 30 * 86_400_000 }]), NOW);
  assertEquals(old.batch.events[0].ts, new Date(NOW).toISOString(), "implausible client clock -> server time");
});

Deno.test("events: product/order ids from Shopify gids, cart key secret stripped, value never trusted as money", () => {
  const n = normalizeTrackingBatch(batch({}, {}, [
    { id: "evt_00000001", name: "add_to_cart", ts: NOW, product: "gid://shopify/ProductVariant/4455", cart: "hWNsynthTOKEN0001?key=deadbeef", value: "999.00", currency: "inr" },
    { id: "evt_00000002", name: "checkout_completed", ts: NOW, order: "gid://shopify/Order/987654" },
    { id: "evt_00000003", name: "page_view", ts: NOW, order: "12345" },
  ]), NOW);
  assertEquals([n.batch.events[0].product_ref, n.batch.events[0].cart_token, n.batch.events[0].value_minor, n.batch.events[0].currency], ["4455", "hWNsynthTOKEN0001", 99900, "INR"]);
  assertEquals(n.batch.events[1].order_ref, "987654");
  assertEquals(n.batch.events[2].order_ref, null, "order ids only accepted on checkout_completed");
  assert(!JSON.stringify(n).includes("deadbeef"));
});

Deno.test("identifiers and consent flags validated; unknown device/browser values dropped", () => {
  assertThrows(() => normalizeTrackingBatch(batch({ k: "sk_secret" }), NOW));
  assertThrows(() => normalizeTrackingBatch(batch({ visitor: "short" }), NOW));
  assertThrows(() => normalizeTrackingBatch(batch({}, { id: "x" }), NOW));
  assertEquals(normalizeTrackingBatch(batch({ consent: {} }), NOW).batch.consent.analytics, false);
  const n = normalizeTrackingBatch(batch({}, { device: "fingerprint-hash", browser: "Mozilla/5.0 (iPhone...)" }), NOW);
  assertEquals([n.batch.session.device_category, n.batch.session.browser_family], [null, null]);
});

Deno.test("Magic Checkout attributes: rzp_3p_utm parsed (incl. utm_id), device first-seen, touchpoint built", () => {
  assertEquals(parseRzpUtm("utm_source:120246356339560442||utm_medium:instagram||utm_campaign:ugc||utm_content:creator_a||utm_id:120250730509700442_v2||utm_term:120250730509700442||junk"),
    { utm_source: "120246356339560442", utm_medium: "instagram", utm_campaign: "ugc", utm_content: "creator_a", utm_id: "120250730509700442_v2", utm_term: "120250730509700442" });
  assertEquals(deviceFirstSeen("1.92c2de7ac657c1a37d41efec00597ee804d423b6.1795439834102.75911674"), new Date(1795439834102).toISOString());
  assertEquals(deviceFirstSeen("garbage"), null);

  const o = shopifyOrder(41, { note_attributes: [
    { name: "Device_details_IP", value: "203.0.113.9" },
    { name: "rzp_3p_utm", value: "utm_source:ig||utm_medium:social||utm_content:link_in_bio" },
    { name: "rzp_3p_utm_ts", value: "1795450266573" },
    { name: "rzp_device_id", value: "1.abc.1795448732353.1" },
    { name: "utm_campaign", value: "Others" },
    { name: "fbclid", value: "PAZsynthetic" },
  ] });
  const [t] = mapOrderTouchpoints(o, ctx, "order-uuid");
  assertEquals([t.touch_type, t.utm_source, t.utm_medium, t.utm_campaign, t.utm_content, t.has_fbclid], ["checkout_capture", "ig", "social", "others", "link_in_bio", true]);
  assertEquals(t.occurred_at, new Date(1795450266573).toISOString());
  assertEquals(t.device_first_seen_at, new Date(1795448732353).toISOString());
  assert(!JSON.stringify(t).includes("203.0.113.9"));
  assertEquals(mapOrderTouchpoints(shopifyOrder(42), ctx, "x"), [], "no attribution -> no touch (unknown, not 'direct')");
  const native = mapOrderTouchpoints(shopifyOrder(43, { landing_site: "/products/x?utm_source=google&utm_medium=cpc&gclid=abc", referring_site: "https://www.google.com/" }), ctx, "y");
  assertEquals([native[0].touch_type, native[0].utm_source, native[0].has_gclid, native[0].referrer_domain], ["storefront_landing", "google", true, "www.google.com"]);
});

Deno.test("link builder: encoding, preserved params, presets, validation, consistent naming", () => {
  const l = buildLink({ placement: "instagram_story", destination_url: "https://125east.in/products/chrome-buds?variant=123#reviews", utm_campaign: "Product Launch!" }, "l_abcd1234", ["125east.in"]);
  const u = new URL(l.final_url);
  assertEquals([u.searchParams.get("variant"), u.hash], ["123", "#reviews"], "existing params + fragment preserved");
  assertEquals([u.searchParams.get("utm_source"), u.searchParams.get("utm_medium"), u.searchParams.get("utm_campaign"), u.searchParams.get("utm_content"), u.searchParams.get("utm_id")],
    ["instagram", "organic_social", "product_launch", "story_link", "l_abcd1234"]);
  const inf = buildLink({ placement: "influencer", destination_url: "https://125east.in/", utm_campaign: "diwali", influencer_handle: "@Priya.Palak" }, "l_abcd1234");
  assertEquals([inf.utm_medium, inf.utm_content, inf.influencer_handle], ["influencer", "priya.palak", "priya.palak"]);
  assertEquals(new URL(buildLink({ placement: "custom", destination_url: "https://125east.in/?q=a b", utm_source: "Partner Site", utm_medium: "Referral", utm_campaign: "x" }, "l_abcd1234").final_url).searchParams.get("q"), "a b", "encoding round-trips");

  const bad = (input: Record<string, unknown>, hosts: string[] = []) => assertThrows(() => buildLink({ placement: "custom", utm_source: "s", utm_medium: "m", utm_campaign: "c", destination_url: "https://125east.in/", ...input } as any, "l_abcd1234", hosts), LinkValidationError);
  bad({ destination_url: "http://125east.in/" });
  bad({ destination_url: "javascript:alert(1)" });
  bad({ destination_url: "not a url" });
  bad({ destination_url: "https://evil.example/" }, ["125east.in"]);
  bad({ destination_url: "https://125east.in/?utm_source=old" });
  bad({ utm_campaign: "!!!" });
  bad({ placement: "influencer", influencer_handle: "" });
  assertThrows(() => buildLink({ placement: "custom", destination_url: "https://125east.in/", utm_source: "s", utm_medium: "m", utm_campaign: "c" }, "BAD"), LinkValidationError);
  assertEquals(slugUtm("  Diwali / Sale 2026 ✨ "), "diwali_sale_2026");
  for (let i = 0; i < 50; i++) assert(/^l_[a-z0-9]{8}$/.test(newLinkCode()));
});
