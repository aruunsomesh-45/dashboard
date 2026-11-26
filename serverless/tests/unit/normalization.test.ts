// Phase 3 normalisers: money, nulls vs zeros, currency, timestamps, statuses, attribution, PII.
// [UNIT, synthetic fixtures shaped like the platforms' documented payloads; no network, no DB]
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  intOrNull,
  isIsoCurrency,
  localToUtcIso,
  mapDelhiveryShipment,
  mapGa4DailyRow,
  mapGa4TransactionRow,
  mapInstagramSnapshot,
  mapMetaAdInsightDay,
  mapRazorpayPayment,
  mapRazorpayRefund,
  mapShopifyLineItems,
  mapShopifyOrder,
  mapShopifyRefund,
  normalizeCurrency,
  normalizeDelhiveryStatus,
  parseAttribution,
  razorpayOrderRef,
  shopifyRefundedTotal,
  toMinorOrNull,
} from "../../supabase/functions/_shared/mappers.ts";
import { canonicalJson, REDACTED, redactPii } from "../../supabase/functions/_shared/pii.ts";
import { razorpayPayment, shopifyOrder } from "../helpers/payloads.ts";

const ctx = { workspace_id: "00000000-0000-4000-8000-000000000001", brand_id: "00000000-0000-4000-8000-000000000002" };

Deno.test("money: NULL for missing/garbage, exact minor units otherwise", () => {
  assertEquals(toMinorOrNull(undefined), null);
  assertEquals(toMinorOrNull(null), null);
  assertEquals(toMinorOrNull(""), null);
  assertEquals(toMinorOrNull("abc"), null);
  assertEquals(toMinorOrNull("0"), 0, "a real zero stays zero");
  assertEquals(toMinorOrNull("0.00"), 0);
  assertEquals(toMinorOrNull("1,299.50"), 129950);
  assertEquals(toMinorOrNull(0.1 + 0.2), 30, "no float drift");
  assertEquals(toMinorOrNull("19.995"), 2000, "half-up rounding");
  assertEquals(intOrNull("12"), 12);
  assertEquals(intOrNull(undefined), null);
  assertEquals(intOrNull("-3"), null, "negative counters are not valid metrics");
});

Deno.test("currency: ISO-4217 upper-case; invalid values are kept visible for data quality", () => {
  assertEquals(normalizeCurrency("inr"), "INR");
  assertEquals(normalizeCurrency(" usd "), "USD");
  assertEquals(normalizeCurrency(""), "INR");
  assertEquals(normalizeCurrency("Rs."), "RS.");
  assert(isIsoCurrency("INR"));
  assert(!isIsoCurrency("RS."));
  assert(!isIsoCurrency("inr"));
});

Deno.test("timestamps: offset-less courier times are IST, output is UTC", () => {
  assertEquals(localToUtcIso("2026-11-20T14:30:00"), "2026-11-20T09:00:00.000Z");
  assertEquals(localToUtcIso("2026-11-20 14:30:00.123"), "2026-11-20T09:00:00.123Z");
  assertEquals(localToUtcIso("2026-11-20T14:30:00Z"), "2026-11-20T14:30:00.000Z", "explicit offset respected");
  assertEquals(localToUtcIso("2026-11-20T14:30:00+00:00"), "2026-11-20T14:30:00.000Z");
  assertEquals(localToUtcIso("not a date"), null);
  assertEquals(localToUtcIso(""), null);
});

Deno.test("attribution: UTM extracted, other query params dropped, referrer reduced to domain", () => {
  const a = parseAttribution("/products/shirt?utm_source=Instagram&utm_medium=Paid_Social&utm_campaign=Diwali-26&email=a@b.c", "https://l.instagram.com/?u=x");
  assertEquals(a, { landing_path: "/products/shirt", referring_domain: "l.instagram.com", utm_source: "instagram", utm_medium: "paid_social", utm_campaign: "diwali-26" });
  assertEquals(parseAttribution(null, null), { landing_path: null, referring_domain: null, utm_source: null, utm_medium: null, utm_campaign: null });
  assertEquals(parseAttribution("https://shop.example/", "google.com").referring_domain, "google.com");
});

Deno.test("Shopify order: original statuses kept, subtotal/refunds/gateways/UTM captured", () => {
  const o = shopifyOrder(7, {
    financial_status: "partially_refunded",
    taxes_included: false,
    payment_gateway_names: ["Razorpay Secure"],
    source_name: "web",
    landing_site: "/?utm_source=google&utm_medium=cpc&utm_campaign=brand",
    refunds: [
      { id: 91, created_at: "2026-11-11T10:00:00+05:30", transactions: [{ kind: "refund", status: "success", amount: "200.00" }] },
      { id: 92, transactions: [{ kind: "refund", status: "failure", amount: "50.00" }] },
    ],
  });
  const row = mapShopifyOrder(o, ctx);
  assertEquals(row.gross_amount, 118000, "existing column keeps meaning: order total");
  assertEquals(row.subtotal_amount, 100000);
  assertEquals(row.refunded_amount, 20000, "only successful refund transactions count");
  assertEquals(row.financial_status, "partially_refunded");
  assertEquals(row.source_financial_status, "partially_refunded");
  assertEquals(row.taxes_included, false);
  assertEquals(row.payment_gateways, ["Razorpay Secure"]);
  assertEquals([row.utm_source, row.utm_medium, row.utm_campaign], ["google", "cpc", "brand"]);
  assertEquals(row.source_created_at, "2026-11-10T04:30:00.000Z", "stored in UTC");

  const authorized = mapShopifyOrder(shopifyOrder(8, { financial_status: "authorized" }), ctx);
  assertEquals([authorized.financial_status, authorized.source_financial_status], ["pending", "authorized"], "canonical + original both kept");

  assertEquals(shopifyRefundedTotal(shopifyOrder(9)), null, "no refunds key: unknown, not zero");
  assertEquals(shopifyRefundedTotal(shopifyOrder(9, { refunds: [] })), 0, "empty refunds list: a real zero");
});

Deno.test("Shopify refund + line item identifiers", () => {
  const ok = mapShopifyRefund({ id: 1, order_id: 77, transactions: [{ kind: "refund", status: "success", amount: "99.50" }] }, ctx, "77", "inr");
  assertEquals([ok.amount_minor, ok.status, ok.currency, ok.order_provider_id], [9950, "processed", "INR", "77"]);
  const pending = mapShopifyRefund({ id: 2, transactions: [{ kind: "refund", status: "pending", amount: "10" }] }, ctx, "77", "INR");
  assertEquals(pending.status, "pending");
  const failed = mapShopifyRefund({ id: 3, transactions: [{ kind: "refund", status: "failure", amount: "10" }] }, ctx, "77", "INR");
  assertEquals([failed.status, failed.amount_minor], ["failed", 0]);
  assertThrows(() => mapShopifyRefund({}, ctx, "77", "INR"));

  const lines = mapShopifyLineItems(shopifyOrder(4, { line_items: [{ id: 41, product_id: 900, variant_id: 901, title: "T", price: "1", quantity: 1 }] }), "oid");
  assertEquals([lines[0].provider_line_id, lines[0].provider_product_id, lines[0].provider_variant_id], ["41", "900", "901"]);
});

Deno.test("Razorpay: original status, refunds, order reference only from order-like note keys", () => {
  const p = mapRazorpayPayment(razorpayPayment("pay_X1", { status: "captured", amount_refunded: 5000, refund_status: "partial", notes: { shopify_order_id: "450789469", address: "secret street" } }), ctx);
  assertEquals([p.source_status, p.refunded_amount_minor, p.refund_status], ["captured", 5000, "partial"]);
  assertEquals([p.merchant_order_ref, p.merchant_order_ref_key], ["450789469", "shopify_order_id"]);

  const unknown = mapRazorpayPayment(razorpayPayment("pay_X2", { status: "weird_new_state" }), ctx);
  assertEquals([unknown.status, unknown.source_status], ["failed", "weird_new_state"], "original preserved so data quality can flag it");

  assertEquals(razorpayOrderRef([]), { merchant_order_ref: "", merchant_order_ref_key: "" }, "Razorpay sends [] for empty notes");
  assertEquals(razorpayOrderRef({ comment: "order 1001 please" }).merchant_order_ref, "", "free text is never parsed for ids");
  assertEquals(razorpayOrderRef({ order_number: "#1001" }).merchant_order_ref, "#1001");
  assertEquals(razorpayOrderRef({ order_id: "1001; drop table" }).merchant_order_ref, "", "only id-shaped values");

  const r = mapRazorpayRefund({ id: "rfnd_1", payment_id: "pay_X1", amount: 5000, currency: "INR", status: "processed", created_at: 1763712000 }, ctx);
  assertEquals([r.provider_id, r.payment_provider_id, r.amount_minor, r.status, r.source_created_at], ["rfnd_1", "pay_X1", 5000, "processed", "2025-11-21T08:00:00.000Z"]);
});

Deno.test("Delhivery: status mapping table", () => {
  const cases: Array<[string, string, string]> = [
    ["UD", "Manifested", "pickup_pending"],
    ["UD", "Not Picked", "pickup_pending"],
    ["PU", "Picked Up", "picked_up"],
    ["UD", "In Transit", "in_transit"],
    ["UD", "Pending", "in_transit"],
    ["UD", "Dispatched", "out_for_delivery"],
    ["UD", "Out for delivery", "out_for_delivery"],
    ["UD", "Undelivered", "ndr"],
    ["DL", "Delivered", "delivered"],
    ["RT", "RTO Initiated", "rto_initiated"],
    ["RT", "In Transit", "rto_in_transit"],
    ["RT", "Returned", "rto_delivered"],
    ["CN", "Cancelled", "cancelled"],
    ["XX", "Something new", "unknown"],
  ];
  for (const [t, s, want] of cases) assertEquals(normalizeDelhiveryStatus(t, s), want, `${t}/${s}`);
});

Deno.test("Delhivery: shipment + ordered event history, IST -> UTC, milestones derived from scans", () => {
  const { shipment, events } = mapDelhiveryShipment({
    AWB: "1234567890", ReferenceNo: "#1001", OrderType: "COD", PickUpDate: "2026-11-18T12:00:00",
    Status: { Status: "Delivered", StatusType: "DL", StatusDateTime: "2026-11-20T18:15:00", StatusLocation: "Mumbai" },
    Scans: [
      { ScanDetail: { Scan: "Delivered", ScanType: "DL", ScanDateTime: "2026-11-20T18:15:00", ScannedLocation: "Mumbai" } },
      { ScanDetail: { Scan: "Manifested", ScanType: "UD", ScanDateTime: "2026-11-18T10:00:00", ScannedLocation: "Delhi" } },
      { ScanDetail: { Scan: "In Transit", ScanType: "UD", ScanDateTime: "2026-11-18T20:00:00", ScannedLocation: "Delhi Hub" } },
      { ScanDetail: { Scan: "Undelivered", ScanType: "UD", ScanDateTime: "2026-11-19T17:00:00", ScannedLocation: "Mumbai", Instructions: "Customer not available" } },
    ],
  }, ctx);
  assertEquals(shipment.canonical_status, "delivered");
  assertEquals(shipment.order_ref, "#1001");
  assertEquals(shipment.picked_up_at, "2026-11-18T06:30:00.000Z");
  assertEquals(shipment.shipped_at, "2026-11-18T14:30:00.000Z", "dispatch = first in-transit scan");
  assertEquals(shipment.delivered_at, "2026-11-20T12:45:00.000Z");
  assertEquals(shipment.last_tracking_at, "2026-11-20T12:45:00.000Z");
  assertEquals([shipment.ndr_count, shipment.return_status, shipment.payment_mode], [1, null, "cod"]);
  assertEquals(events.map((e: any) => e.canonical_status), ["pickup_pending", "in_transit", "ndr", "delivered"], "history ordered, nothing overwritten");
  assertEquals(events[2].status_description, "Customer not available");
  assertThrows(() => mapDelhiveryShipment({}, ctx));
});

Deno.test("Meta ad-level: missing metrics stay NULL, platform ratios kept as reported", () => {
  const base = { date_start: "2026-11-20", ad_id: "6001", adset_id: "5001", campaign_id: "4001", campaign_name: "Diwali" };
  const full = mapMetaAdInsightDay({ ...base, spend: "1500.25", impressions: "10000", reach: "8000", clicks: "250", cpm: "150.025", ctr: "2.5",
    actions: [{ action_type: "omni_purchase", value: "12" }, { action_type: "purchase", value: "11" }, { action_type: "link_click", value: "240" }],
    action_values: [{ action_type: "omni_purchase", value: "36000.00" }] }, ctx, { adAccountId: "act_1", currency: "inr" });
  assertEquals([full.spend_minor, full.impressions, full.reach, full.clicks], [150025, 10000, 8000, 250]);
  assertEquals([full.purchases, full.purchase_value_minor], [12, 3600000], "overlapping purchase types: max, never sum");
  assertEquals([full.meta_cpm, full.meta_ctr, full.meta_cpc], [150.025, 2.5, null]);
  assertEquals(full.currency, "INR");

  const sparse = mapMetaAdInsightDay({ ...base, spend: "0" }, ctx, { adAccountId: "act_1", currency: "INR" });
  assertEquals(sparse.spend_minor, 0, "reported zero spend is zero");
  assertEquals([sparse.impressions, sparse.reach, sparse.clicks, sparse.purchases, sparse.purchase_value_minor], [null, null, null, null, null], "not returned = unknown");

  const noPurchase = mapMetaAdInsightDay({ ...base, actions: [{ action_type: "link_click", value: "3" }] }, ctx, { adAccountId: "act_1", currency: "INR" });
  assertEquals(noPurchase.purchases, 0, "actions returned without a purchase = real zero");
  assertThrows(() => mapMetaAdInsightDay({ date_start: "2026-11-20" }, ctx, { adAccountId: "act_1", currency: "INR" }));
});

Deno.test("Instagram snapshot: both Graph insight shapes; unreported metrics NULL", () => {
  const snap = mapInstagramSnapshot({ id: "m1", like_count: 40, comments_count: 0 }, {
    data: [{ name: "reach", values: [{ value: 900 }] }, { name: "saved", total_value: { value: 7 } }, { name: "shares", values: [{ value: 0 }] }],
  }, ctx, "2026-11-23");
  assertEquals([snap.reach, snap.saves, snap.shares, snap.likes, snap.comments], [900, 7, 0, 40, 0]);
  assertEquals([snap.impressions, snap.views, snap.total_interactions], [null, null, null]);
});

Deno.test("GA4: dimensions verbatim incl. (not set); metrics NULL when absent; transactions need an id", () => {
  const report = {
    dimensionHeaders: [{ name: "date" }, { name: "sessionSource" }, { name: "sessionMedium" }, { name: "sessionCampaignName" }, { name: "landingPage" }, { name: "deviceCategory" }],
    metricHeaders: [{ name: "sessions" }, { name: "totalUsers" }, { name: "purchaseRevenue" }],
  };
  const row = { dimensionValues: [{ value: "20261120" }, { value: "google" }, { value: "cpc" }, { value: "(not set)" }, { value: "/" }, { value: "mobile" }], metricValues: [{ value: "120" }, { value: "95" }, { value: "4599.5" }] };
  const g = mapGa4DailyRow(report, row, ctx, "properties/123", "INR");
  assertEquals([g.report_date, g.session_campaign, g.sessions, g.total_users, g.purchase_revenue_minor], ["2026-11-20", "(not set)", 120, 95, 459950]);
  assertEquals([g.new_users, g.screen_page_views, g.key_events, g.transactions], [null, null, null, null]);
  assertThrows(() => mapGa4DailyRow(report, { dimensionValues: [{ value: "2026-11-20" }] }, ctx, "p", "INR"));

  const txReport = { dimensionHeaders: [{ name: "date" }, { name: "transactionId" }, { name: "sessionSource" }], metricHeaders: [{ name: "purchaseRevenue" }] };
  assertEquals(mapGa4TransactionRow(txReport, { dimensionValues: [{ value: "20261120" }, { value: "(not set)" }, { value: "google" }], metricValues: [{ value: "1" }] }, ctx, "p", "INR"), null);
  const tx = mapGa4TransactionRow(txReport, { dimensionValues: [{ value: "20261120" }, { value: "1001" }, { value: "google" }], metricValues: [{ value: "1180" }] }, ctx, "p", "INR");
  assertEquals([tx?.transaction_id, tx?.session_source, tx?.session_medium, tx?.purchase_revenue_minor], ["1001", "google", "(not set)", 118000]);
});

Deno.test("PII: contact/address data removed, identifiers and money untouched", () => {
  const order = shopifyOrder(5, {
    email: "buyer5@example.test", phone: "+919999999999", browser_ip: "1.2.3.4", note: "call me at 98765",
    billing_address: { first_name: "A", address1: "1 Street", zip: "110001" },
    shipping_address: null,
    client_details: { browser_ip: "1.2.3.4" },
  });
  const red = redactPii(order) as any;
  const text = JSON.stringify(red);
  for (const secret of ["buyer5@example.test", "+919999999999", "1.2.3.4", "1 Street", "110001", "98765", "Buyer"]) {
    assert(!text.includes(secret), `leaked ${secret}`);
  }
  assertEquals(red.customer.id, 5005, "customer id kept for matching");
  assertEquals(red.customer.email, REDACTED, "presence of the field still visible");
  assertEquals([red.id, red.total_price, red.currency, red.line_items.length], [5, "1180.00", "INR", 2]);
  assertEquals(red.shipping_address, null, "null stays null (absent vs present)");
  assertEquals(red.line_items[0].title, "Linen Shirt");

  const pay = redactPii(razorpayPayment("pay_1", { email: "x@y.z", contact: "+91999", vpa: "x@upi", card: { last4: "1111" }, notes: { shopify_order_id: "123", customer_name: "Ravi", address: "Flat 2" } })) as any;
  assertEquals([pay.email, pay.contact, pay.vpa, pay.card], [REDACTED, REDACTED, REDACTED, REDACTED]);
  assertEquals(pay.notes, { shopify_order_id: "123", customer_name: REDACTED, address: REDACTED });
  assertEquals([pay.amount, pay.status], [118000, "captured"]);
});

Deno.test("canonicalJson: key order does not change the hash input", () => {
  assertEquals(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } }), canonicalJson({ a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 }));
  assert(canonicalJson({ a: 1 }) !== canonicalJson({ a: "1" }));
});

Deno.test("checkout note attributes: allow-list only; payment/order/cart identifiers validated; PII never read or kept", () => {
  const order = shopifyOrder(31, {
    note_attributes: [
      { name: "Paid via", value: "Razorpay Magic Checkout" },
      { name: "Device_details_IP", value: "203.0.113.7" },
      { name: "Additional Notes", value: "call +91 90000 00000" },
      { name: "razorpay_payment_id", value: "pay_SYNTH00000001" },
      { name: "razorpay_order_id", value: "order_SYNTH0000001" },
      { name: "cart_token", value: "hWNsynthTOKEN0001?key=deadbeefdeadbeef" },
      { name: "utm_source", value: "ig" },
    ],
  });
  const row = mapShopifyOrder(order, ctx);
  assertEquals([row.gateway_payment_ref, row.gateway_order_ref, row.checkout_cart_token], ["pay_SYNTH00000001", "order_SYNTH0000001", "hWNsynthTOKEN0001"]);
  assert(!JSON.stringify(row).includes("deadbeef"), "cart key secret never stored");
  assertEquals(mapShopifyOrder(shopifyOrder(32, { note_attributes: [{ name: "razorpay_payment_id", value: "x; drop" }] }), ctx).gateway_payment_ref, "");
  assertEquals(mapShopifyOrder(shopifyOrder(33), ctx).gateway_payment_ref, "", "no attributes -> empty, not invented");

  const red = JSON.stringify(redactPii(order));
  for (const leak of ["203.0.113.7", "+91 90000 00000"]) assert(!red.includes(leak), `raw leaked ${leak}`);
  assert(red.includes("pay_SYNTH00000001") && red.includes('"ig"'), "attribution + ids kept in raw");
  const gql = redactPii({ customAttributes: [{ key: "Device_details_IP", value: "203.0.113.7" }, { key: "utm_medium", value: "social" }] }) as any;
  assertEquals(gql.customAttributes, [{ key: "Device_details_IP", value: REDACTED }, { key: "utm_medium", value: "social" }]);
});
