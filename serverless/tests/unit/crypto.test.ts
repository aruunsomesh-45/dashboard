// Unit tests for AES-256-GCM encryption & decryption
// Run with: deno task test:unit (from serverless/)
Deno.env.set("INTEGRATION_ENCRYPTION_KEY", "unit-test-only-key-not-a-real-secret");

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { encryptCredentials, decryptCredentials, bytesToPostgresHex, parseHexOrBytes } from "../../supabase/functions/_shared/crypto.ts";

Deno.test("Crypto: Encrypt and Decrypt Round-trip", async () => {
  const original = {
    shop_domain: "test-brand.myshopify.com",
    access_token: "shpat_test1234567890",
    key_secret: "secret_xyz",
  };

  const encryptedBytes = await encryptCredentials(original);
  assertEquals(encryptedBytes.length > 28, true); // 12-byte nonce + ciphertext + 16-byte tag

  const decrypted = await decryptCredentials(encryptedBytes);
  assertEquals(decrypted.shop_domain, original.shop_domain);
  assertEquals(decrypted.access_token, original.access_token);
  assertEquals(decrypted.key_secret, original.key_secret);
});

Deno.test("Crypto: Postgres Hex Format (\\x) Compatibility", async () => {
  const original = { provider: "shopify", status: "active" };
  const encryptedBytes = await encryptCredentials(original);
  const hexString = bytesToPostgresHex(encryptedBytes);

  assertEquals(hexString.startsWith("\\x"), true);

  const parsedBytes = parseHexOrBytes(hexString);
  assertEquals(parsedBytes.length, encryptedBytes.length);

  const decrypted = await decryptCredentials(hexString);
  assertEquals(decrypted.provider, "shopify");
  assertEquals(decrypted.status, "active");
});

// ── Failure modes ────────────────────────────────────────────────────────────
import { assertRejects, assertThrows } from "jsr:@std/assert@1";

Deno.test("Crypto: tampered ciphertext is rejected (GCM auth tag)", async () => {
  const bytes = await encryptCredentials({ access_token: "shpat_x" });
  bytes[bytes.length - 1] ^= 0xff;
  await assertRejects(() => decryptCredentials(bytes), Error, "Failed to decrypt");
});

Deno.test("Crypto: data encrypted under a different master key cannot be decrypted (expired/rotated key)", async () => {
  const bytes = await encryptCredentials({ access_token: "shpat_x" });
  const prev = Deno.env.get("INTEGRATION_ENCRYPTION_KEY")!;
  Deno.env.set("INTEGRATION_ENCRYPTION_KEY", "a-different-key");
  try {
    await assertRejects(() => decryptCredentials(bytes), Error, "Failed to decrypt");
  } finally {
    Deno.env.set("INTEGRATION_ENCRYPTION_KEY", prev);
  }
});

Deno.test("Crypto: no key configured -> explicit misconfiguration error (no hard-coded fallback)", async () => {
  const prev = Deno.env.get("INTEGRATION_ENCRYPTION_KEY")!;
  const prevSecret = Deno.env.get("SECRET_KEY");
  Deno.env.delete("INTEGRATION_ENCRYPTION_KEY");
  Deno.env.delete("SECRET_KEY");
  try {
    await assertRejects(() => encryptCredentials({ a: 1 }), Error, "INTEGRATION_ENCRYPTION_KEY is not set");
  } finally {
    Deno.env.set("INTEGRATION_ENCRYPTION_KEY", prev);
    if (prevSecret) Deno.env.set("SECRET_KEY", prevSecret);
  }
});

Deno.test("Crypto: empty / short input -> {} ; invalid hex -> error", async () => {
  assertEquals(await decryptCredentials(null), {});
  const PG_HEX = String.fromCharCode(92) + "x"; // Postgres bytea hex prefix: backslash-x
  assertEquals(await decryptCredentials(PG_HEX + "00"), {});
  assertEquals((await encryptCredentials({})).length, 0);
  assertThrows(() => parseHexOrBytes(PG_HEX + "ZZ"), Error, "not valid hex");
  assertThrows(() => parseHexOrBytes(PG_HEX + "abc"), Error, "not valid hex");
});
