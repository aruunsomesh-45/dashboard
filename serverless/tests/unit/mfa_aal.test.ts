// requireAuth's 2FA gate: users with a verified TOTP factor need an aal2 JWT. [PURE + handler with doubles]
import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { jwtAal, requireAuth, requiresAal2 } from "../../supabase/functions/_shared/auth.ts";
import { HttpError } from "../../supabase/functions/_shared/http.ts";

const jwt = (claims: Record<string, unknown>) =>
  `h.${btoa(JSON.stringify(claims)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}.sig`;

Deno.test("jwtAal reads the aal claim; malformed tokens count as aal1", () => {
  assertEquals(jwtAal(`Bearer ${jwt({ aal: "aal2" })}`), "aal2");
  assertEquals(jwtAal(`Bearer ${jwt({ aal: "aal1" })}`), "aal1");
  assertEquals(jwtAal(`Bearer ${jwt({ sub: "x" })}`), "aal1");
  assertEquals(jwtAal("Bearer not-a-jwt"), "aal1");
});

Deno.test("requiresAal2 only for a VERIFIED totp factor", () => {
  assertEquals(requiresAal2({ factors: [] }), false);
  assertEquals(requiresAal2({ factors: null }), false);
  assertEquals(requiresAal2({ factors: [{ factor_type: "totp", status: "unverified" }] }), false);
  assertEquals(requiresAal2({ factors: [{ factor_type: "totp", status: "verified" }] }), true);
});

function depsFor(user: Record<string, unknown>) {
  // deno-lint-ignore no-explicit-any
  return { userClient: () => ({ auth: { getUser: () => Promise.resolve({ data: { user }, error: null }) } }) as any };
}
const req = (token: string) => new Request("http://x/fn", { method: "POST", headers: { Authorization: `Bearer ${token}` } });

Deno.test("requireAuth: 2FA user with aal1 token -> 401; with aal2 -> ok; non-2FA user with aal1 -> ok", async () => {
  const mfaUser = { id: "u1", email: "a@x", factors: [{ factor_type: "totp", status: "verified" }] };
  const err = await assertRejects(() => requireAuth(req(jwt({ aal: "aal1" })), depsFor(mfaUser)), HttpError);
  assertEquals(err.status, 401);
  assertEquals((await requireAuth(req(jwt({ aal: "aal2" })), depsFor(mfaUser))).user.id, "u1");
  assertEquals((await requireAuth(req(jwt({ aal: "aal1" })), depsFor({ id: "u2", email: "b@x", factors: [] }))).user.id, "u2");
});
