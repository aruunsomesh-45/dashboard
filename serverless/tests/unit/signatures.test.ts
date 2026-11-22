// Webhook signature verification - platform algorithms over RAW bytes.  [MOCKED: pure functions]
import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import {
  sha256Hex,
  signRazorpay,
  signShopify,
  timingSafeEqual,
  verifyRazorpaySignature,
  verifyShopifyHmac,
} from "../../supabase/functions/_shared/signatures.ts";

const enc = new TextEncoder();

// Independent reference implementation (node:crypto) so we are not testing the code against itself.
import { createHmac } from "node:crypto";
const refB64 = (secret: string, body: string) => createHmac("sha256", secret).update(body, "utf8").digest("base64");
const refHex = (secret: string, body: string) => createHmac("sha256", secret).update(body, "utf8").digest("hex");

const BODY = '{"id":820982911946154500,"total_price":"199.00","note":"café ☃"}';

Deno.test("Shopify: signature equals base64 HMAC-SHA256 (matches node:crypto reference)", async () => {
  assertEquals(await signShopify("shpss_test_secret", BODY), refB64("shpss_test_secret", BODY));
});

Deno.test("Razorpay: signature equals hex HMAC-SHA256 (matches node:crypto reference)", async () => {
  assertEquals(await signRazorpay("rzp_whsec", BODY), refHex("rzp_whsec", BODY));
});

Deno.test("Shopify: valid HMAC accepted", async () => {
  assert(await verifyShopifyHmac("s3cret", enc.encode(BODY), refB64("s3cret", BODY)));
});

Deno.test("Shopify: tolerates surrounding whitespace in header", async () => {
  assert(await verifyShopifyHmac("s3cret", enc.encode(BODY), `  ${refB64("s3cret", BODY)}\n`));
});

Deno.test("Shopify: wrong secret rejected", async () => {
  assertFalse(await verifyShopifyHmac("other", enc.encode(BODY), refB64("s3cret", BODY)));
});

Deno.test("Shopify: body re-serialised (whitespace change) rejected - must use raw bytes", async () => {
  const reserialised = JSON.stringify(JSON.parse(BODY), null, 1);
  assertFalse(await verifyShopifyHmac("s3cret", enc.encode(reserialised), refB64("s3cret", BODY)));
});

Deno.test("Shopify: hex-encoded signature (wrong encoding) rejected", async () => {
  assertFalse(await verifyShopifyHmac("s3cret", enc.encode(BODY), refHex("s3cret", BODY)));
});

Deno.test("Shopify: missing header / missing secret rejected", async () => {
  assertFalse(await verifyShopifyHmac("s3cret", enc.encode(BODY), null));
  assertFalse(await verifyShopifyHmac("", enc.encode(BODY), refB64("", BODY)));
});

Deno.test("Razorpay: valid signature accepted (case-insensitive hex)", async () => {
  const sig = refHex("whsec", BODY);
  assert(await verifyRazorpaySignature("whsec", enc.encode(BODY), sig));
  assert(await verifyRazorpaySignature("whsec", enc.encode(BODY), sig.toUpperCase()));
});

Deno.test("Razorpay: tampered body rejected", async () => {
  const sig = refHex("whsec", BODY);
  assertFalse(await verifyRazorpaySignature("whsec", enc.encode(BODY.replace("199.00", "1.00")), sig));
});

Deno.test("Razorpay: API key secret is not the webhook secret", async () => {
  assertFalse(await verifyRazorpaySignature("api_key_secret", enc.encode(BODY), refHex("whsec", BODY)));
});

Deno.test("Razorpay: base64 signature (wrong encoding) / empty / missing rejected", async () => {
  assertFalse(await verifyRazorpaySignature("whsec", enc.encode(BODY), refB64("whsec", BODY)));
  assertFalse(await verifyRazorpaySignature("whsec", enc.encode(BODY), ""));
  assertFalse(await verifyRazorpaySignature("whsec", enc.encode(BODY), null));
});

Deno.test("timingSafeEqual: equal, different, different length", () => {
  assert(timingSafeEqual("abc", "abc"));
  assertFalse(timingSafeEqual("abc", "abd"));
  assertFalse(timingSafeEqual("abc", "abcd"));
  assert(timingSafeEqual("", ""));
});

Deno.test("sha256Hex: known vector", async () => {
  assertEquals(await sha256Hex(enc.encode("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});
