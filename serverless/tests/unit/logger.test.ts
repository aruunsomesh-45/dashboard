// Unit tests for log redaction (renamed from connection.test.ts - it only ever tested the logger)
// Run with: deno task test:unit (from serverless/)

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { redactSensitiveData } from "../../supabase/functions/_shared/logger.ts";

Deno.test("Logger: Sensitive Data Redaction", () => {
  const sensitiveObj = {
    user: "test@125east.com",
    access_token: "shpat_live_very_secret_token_12345",
    password: "super_secret_password",
    nested: {
      key_secret: "rzp_secret_67890",
      normal_field: "public_value",
    },
  };

  const redacted: any = redactSensitiveData(sensitiveObj);

  assertEquals(redacted.user, "test@125east.com");
  assertEquals(redacted.access_token.includes("...[REDACTED]"), true);
  assertEquals(redacted.password, "[REDACTED]");
  assertEquals(redacted.nested.key_secret.includes("...[REDACTED]"), true);
  assertEquals(redacted.nested.normal_field, "public_value");
});

Deno.test("Logger: signature headers, api keys, cookies and arrays are redacted", () => {
  const r: any = redactSensitiveData({
    headers: { "x-shopify-hmac-sha256": "abcdefghijklmnop", apikey: "eyJhbGciOiJIUzI1NiJ9.payload", "x-razorpay-signature": "deadbeefdeadbeef", cookie: "sessionid=abc123456" },
    list: [{ access_token: "EAAB_secret_token_value" }],
    count: 5,
  });
  for (const v of Object.values(r.headers)) assertEquals(String(v).includes("[REDACTED]"), true, String(v));
  assertEquals(r.list[0].access_token.includes("[REDACTED]"), true);
  assertEquals(r.count, 5);
});

Deno.test("Logger: long secrets keep at most a 4-char prefix", () => {
  const r: any = redactSensitiveData({ access_token: "shpat_0123456789abcdef" });
  assertEquals(r.access_token, "shpa...[REDACTED]");
});
