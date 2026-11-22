// Response parsing / normalisation / pagination helpers.  [MOCKED: pure functions, synthetic payloads]
import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  classifyMetaError,
  extractShopifyNextPageUrl,
  mapMetaInsightDay,
  mapRazorpayPayment,
  mapShopifyCustomer,
  mapShopifyLineItems,
  mapShopifyOrder,
  normalizeMetaAdAccountId,
  normalizeRazorpayMethod,
  normalizeRazorpayStatus,
  normalizeShopDomain,
  normalizeShopifyFinancialStatus,
  normalizeShopifyFulfillmentStatus,
  toMinor,
} from "../../supabase/functions/_shared/mappers.ts";
import { HttpError } from "../../supabase/functions/_shared/http.ts";

const ctx = { workspace_id: "11111111-1111-1111-1111-111111111111", brand_id: "22222222-2222-2222-2222-222222222222" };

Deno.test("toMinor: exact decimal -> paise conversion without float drift", () => {
  assertEquals(toMinor("199.99"), 19999);
  assertEquals(toMinor("0.29"), 29); // 0.29*100 = 28.999999999999996 with naive float math
  assertEquals(toMinor("1.005"), 101); // half-up
  assertEquals(toMinor("1,299.50"), 129950);
  assertEquals(toMinor(10), 1000);
  assertEquals(toMinor(".5"), 50);
  assertEquals(toMinor("-12.30"), -1230);
});

Deno.test("toMinor: invalid / empty input -> 0", () => {
  for (const v of [null, undefined, "", "abc", "1.2.3", {}, "NaN"]) assertEquals(toMinor(v), 0);
});

Deno.test("normalizeShopDomain: accepts store forms", () => {
  assertEquals(normalizeShopDomain("My-Store.myshopify.com"), "my-store.myshopify.com");
  assertEquals(normalizeShopDomain("https://my-store.myshopify.com/admin/orders"), "my-store.myshopify.com");
  assertEquals(normalizeShopDomain("my-store"), "my-store.myshopify.com");
});

Deno.test("normalizeShopDomain: rejects non-Shopify hosts (prevents token exfiltration / SSRF)", () => {
  for (const bad of ["", "evil.com", "my-store.myshopify.com.evil.com", "169.254.169.254", "localhost:54321", "x.myshopify.com@evil.com"]) {
    const e = assertThrows(() => normalizeShopDomain(bad), HttpError);
    assertEquals(e.status, 400);
  }
});

Deno.test("Shopify financial status -> schema CHECK values", () => {
  const allowed = new Set(["pending", "paid", "partially_refunded", "refunded", "voided"]);
  for (const s of ["pending", "authorized", "partially_paid", "paid", "partially_refunded", "refunded", "voided", "expired", "weird", null]) {
    assertEquals(allowed.has(normalizeShopifyFinancialStatus(s)), true, String(s));
  }
  assertEquals(normalizeShopifyFinancialStatus("PAID"), "paid");
  assertEquals(normalizeShopifyFinancialStatus("authorized"), "pending");
  assertEquals(normalizeShopifyFinancialStatus("expired"), "voided");
});

Deno.test("Shopify fulfillment status: null -> unfulfilled (column is NOT NULL)", () => {
  assertEquals(normalizeShopifyFulfillmentStatus(null), "unfulfilled");
  assertEquals(normalizeShopifyFulfillmentStatus("fulfilled"), "fulfilled");
  assertEquals(normalizeShopifyFulfillmentStatus("partial"), "partial");
  assertEquals(normalizeShopifyFulfillmentStatus("on_hold"), "unfulfilled");
});

Deno.test("mapShopifyOrder: amounts in paise, keyed by provider/provider_id, net excludes tax+shipping", () => {
  const row = mapShopifyOrder({
    id: 450789469,
    order_number: 1001,
    currency: "inr",
    total_price: "1180.00",
    total_discounts: "100.00",
    total_tax: "130.00",
    shipping_lines: [{ price: "50.00" }],
    financial_status: "paid",
    fulfillment_status: null,
    created_at: "2026-11-01T10:00:00+05:30",
    updated_at: "2026-11-02T10:00:00+05:30",
  }, ctx, "33333333-3333-3333-3333-333333333333");
  assertEquals(row.provider, "shopify");
  assertEquals(row.provider_id, "450789469");
  assertEquals(row.order_number, "1001");
  assertEquals(row.currency, "INR");
  assertEquals(row.gross_amount, 118000);
  assertEquals(row.discount_amount, 10000);
  assertEquals(row.tax_amount, 13000);
  assertEquals(row.shipping_amount, 5000);
  assertEquals(row.net_sales, 118000 - 13000 - 5000);
  assertEquals(row.fulfillment_status, "unfulfilled");
  assertEquals(row.source_created_at, "2026-11-01T04:30:00.000Z");
  assertEquals(row.customer_id, "33333333-3333-3333-3333-333333333333");
  // regression: none of the non-existent columns the old code wrote
  for (const bad of ["external_id", "gross_amount_minor", "net_sales_minor"]) assertEquals(bad in row, false);
});

Deno.test("mapShopifyOrder: missing id throws; missing optional fields default safely", () => {
  assertThrows(() => mapShopifyOrder({ total_price: "1.00" }, ctx));
  const row = mapShopifyOrder({ id: 1 }, ctx);
  assertEquals(row.gross_amount, 0);
  assertEquals(row.order_number, "1");
  assertEquals(row.financial_status, "pending");
  assertEquals(row.source_created_at, null);
});

Deno.test("mapShopifyCustomer: no fabricated placeholder emails; null customer -> null", () => {
  assertEquals(mapShopifyCustomer(null, ctx), null);
  const c = mapShopifyCustomer({ id: 7, email: null, first_name: "A" }, ctx)!;
  assertEquals(c.email, "");
  assertEquals(c.provider_id, "7");
  assertEquals(mapShopifyCustomer({ id: 8, email: " X@Y.COM " }, ctx)!.email, "x@y.com");
});

Deno.test("mapShopifyLineItems: quantity >= 1, non-negative prices, title required", () => {
  const lines = mapShopifyLineItems({ line_items: [{ title: "", sku: "S1", quantity: 0, price: "-5", total_discount: "1.10" }] }, "oid");
  assertEquals(lines[0].quantity, 1);
  assertEquals(lines[0].price_minor, 0);
  assertEquals(lines[0].total_discount_minor, 110);
  assertEquals(lines[0].title, "Untitled item");
  assertEquals(mapShopifyLineItems({}, "oid"), []);
});

Deno.test("Shopify Link header pagination", () => {
  const h = '<https://s.myshopify.com/admin/api/2024-10/orders.json?page_info=abc&limit=250>; rel="next", <https://s.myshopify.com/admin/api/2024-10/orders.json?page_info=zzz>; rel="previous"';
  assertEquals(extractShopifyNextPageUrl(h, "s.myshopify.com"), "https://s.myshopify.com/admin/api/2024-10/orders.json?page_info=abc&limit=250");
  assertEquals(extractShopifyNextPageUrl('<https://s.myshopify.com/x>; rel="previous"', "s.myshopify.com"), null);
  assertEquals(extractShopifyNextPageUrl(null), null);
  // a next link pointing at another host is never followed (token would be sent there)
  assertEquals(extractShopifyNextPageUrl('<https://evil.com/x>; rel="next"', "s.myshopify.com"), null);
  assertEquals(extractShopifyNextPageUrl('<http://s.myshopify.com/x>; rel="next"', "s.myshopify.com"), null);
});

Deno.test("Razorpay status/method -> schema CHECK values", () => {
  const st = new Set(["authorized", "captured", "failed", "refunded"]);
  for (const s of ["created", "authorized", "captured", "refunded", "failed", "???", null]) assertEquals(st.has(normalizeRazorpayStatus(s)), true);
  assertEquals(normalizeRazorpayStatus("captured"), "captured"); // old code wrote "success" -> CHECK violation
  const m = new Set(["upi", "card", "netbanking", "wallet", "emi", "other"]);
  for (const s of ["upi", "card", "netbanking", "wallet", "emi", "cardless_emi", "paylater", "bank_transfer", null]) assertEquals(m.has(normalizeRazorpayMethod(s)), true);
  assertEquals(normalizeRazorpayMethod("paylater"), "other");
});

Deno.test("mapRazorpayPayment: amount already in paise, unix timestamp parsed", () => {
  const r = mapRazorpayPayment({ id: "pay_29QQoUBi66xm2f", amount: 50000, currency: "INR", status: "captured", method: "upi", order_id: "order_9A33XWu170gUtm", created_at: 1763712000 }, ctx);
  assertEquals(r.provider, "razorpay");
  assertEquals(r.provider_id, "pay_29QQoUBi66xm2f");
  assertEquals(r.amount_minor, 50000);
  assertEquals(r.gateway_order_id, "order_9A33XWu170gUtm");
  assertEquals(r.source_created_at, new Date(1763712000 * 1000).toISOString());
  for (const bad of ["external_id", "gateway"]) assertEquals(bad in r, false);
  assertThrows(() => mapRazorpayPayment({ amount: 1 }, ctx));
  assertEquals(mapRazorpayPayment({ id: "pay_x", amount: "garbage" }, ctx).amount_minor, 0);
});

Deno.test("Meta ad account id normalisation", () => {
  assertEquals(normalizeMetaAdAccountId("123456"), "act_123456");
  assertEquals(normalizeMetaAdAccountId("act_123456"), "act_123456");
  assertEquals(normalizeMetaAdAccountId(""), "");
  assertThrows(() => normalizeMetaAdAccountId("act_12/../me"), HttpError);
});

Deno.test("mapMetaInsightDay: purchases are max() over overlapping action types, revenue in paise", () => {
  const r = mapMetaInsightDay({
    date_start: "2026-11-01",
    spend: "1234.56",
    impressions: "10000",
    clicks: "250",
    actions: [{ action_type: "purchase", value: "4" }, { action_type: "omni_purchase", value: "5" }, { action_type: "link_click", value: "99" }],
    action_values: [{ action_type: "purchase", value: "3000.10" }, { action_type: "omni_purchase", value: "3500.00" }],
  }, ctx);
  assertEquals(r.fact_date, "2026-11-01");
  assertEquals(r.spend_minor, 123456);
  assertEquals(r.impressions, 10000);
  assertEquals(r.clicks, 250);
  assertEquals(r.attributed_conversions, 5);
  assertEquals(r.attributed_revenue_minor, 350000);
  for (const bad of ["platform", "date", "purchases", "roas"]) assertEquals(bad in r, false);
});

Deno.test("mapMetaInsightDay: empty metrics -> zeros; bad date throws", () => {
  const r = mapMetaInsightDay({ date_start: "2026-11-02" }, ctx);
  assertEquals([r.spend_minor, r.impressions, r.clicks, r.attributed_conversions], [0, 0, 0, 0]);
  assertThrows(() => mapMetaInsightDay({ date_start: "yesterday" }, ctx));
  assertThrows(() => mapMetaInsightDay({}, ctx));
});

Deno.test("classifyMetaError: token expiry / permission / rate limit", () => {
  assertEquals(classifyMetaError({ error: { code: 190, error_subcode: 463, message: "Session has expired" } }).kind, "token_invalid");
  assertEquals(classifyMetaError({ error: { code: 200, message: "Permissions error" } }).kind, "permission");
  assertEquals(classifyMetaError({ error: { code: 10, message: "no permission" } }).kind, "permission");
  assertEquals(classifyMetaError({ error: { code: 17, message: "User request limit reached" } }).kind, "rate_limit");
  assertEquals(classifyMetaError({ error: { code: 80004, message: "too many calls" } }).kind, "rate_limit");
  assertEquals(classifyMetaError({ error: { code: 100, message: "Invalid parameter" } }).kind, "invalid_request");
  assertEquals(classifyMetaError(null).kind, "unknown");
  assertEquals(classifyMetaError({}).kind, "unknown");
});
