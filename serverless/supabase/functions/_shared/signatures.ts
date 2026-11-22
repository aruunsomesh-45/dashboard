/**
 * Webhook signature verification using each platform's documented algorithm.
 *  - Shopify:  X-Shopify-Hmac-Sha256 = base64( HMAC-SHA256(app client secret, raw body) )
 *  - Razorpay: X-Razorpay-Signature  = hex( HMAC-SHA256(webhook secret, raw body) )
 * Always computed over the RAW request bytes, never over re-serialised JSON.
 */
const enc = new TextEncoder();

async function hmacSha256(secret: string, body: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, body as Uint8Array<ArrayBuffer>));
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time comparison of two strings (length leak only). */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)));
}

export async function signShopify(secret: string, body: Uint8Array | string): Promise<string> {
  return toBase64(await hmacSha256(secret, typeof body === "string" ? enc.encode(body) : body));
}

export async function signRazorpay(secret: string, body: Uint8Array | string): Promise<string> {
  return toHex(await hmacSha256(secret, typeof body === "string" ? enc.encode(body) : body));
}

export async function verifyShopifyHmac(secret: string, body: Uint8Array, header: string | null): Promise<boolean> {
  if (!secret || !header) return false;
  return timingSafeEqual(await signShopify(secret, body), header.trim());
}

export async function verifyRazorpaySignature(secret: string, body: Uint8Array, header: string | null): Promise<boolean> {
  if (!secret || !header) return false;
  return timingSafeEqual(await signRazorpay(secret, body), header.trim().toLowerCase());
}
