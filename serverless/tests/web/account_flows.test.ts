// Two-factor auth, password reset, team invitations and the browser -> Edge Function proxy, end-to-end
// through the REAL route handlers. [REAL route code + LOCAL PGlite DB + in-process fake GoTrue]
import { assert, assertEquals, assertMatch, assertNotEquals } from "jsr:@std/assert@1";
import { applyCookies, cookieValue, hit, totp, WebWorld } from "./harness.ts";

const opts = { sanitizeResources: false, sanitizeOps: false };

Deno.test({ ...opts, name: "Account flows", fn: async (t) => {
  const ww = await WebWorld.create();
  const w = ww.w;
  const api = await import("../../../frontend/src/app/api/[[...path]]/route.ts");
  const login = await import("../../../frontend/src/app/api/auth/login/route.ts");
  const me = await import("../../../frontend/src/app/api/auth/me/route.ts");
  const fnProxy = await import("../../../frontend/src/app/api/fn/[name]/route.ts");

  const A = await ww.tenant("owner@example.test", "Org A");
  const brandA = `/api/w/${A.slug}/b/${A.brand_id}`;

  const signIn = async (email: string, password: string) => {
    const r = await hit(login, "/api/auth/login/", { method: "POST", body: { email, password } });
    return { ...r, jar: applyCookies({}, r.setCookies) };
  };

  // ── 2FA ───────────────────────────────────────────────────────────────────
  let jar: Record<string, string> = {};
  let secret = "";
  let recoveryCodes: string[] = [];

  await t.step("2FA status before enrolment: disabled", async () => {
    jar = (await signIn(A.user.email, A.password)).jar;
    const r = await hit(api, "/api/v1/security/mfa/status/", { cookies: jar });
    assertEquals([r.status, r.body.is_enabled, r.body.is_pending], [200, false, false]);
  });

  await t.step("setup returns a real per-user secret + otpauth URI; wrong code rejected", async () => {
    const r = await hit(api, "/api/v1/security/mfa/setup/", { method: "POST", cookies: jar });
    assertEquals(r.status, 200, JSON.stringify(r.body));
    secret = r.body.secret;
    assertMatch(secret, /^[A-Z2-7]{16,}$/);
    assertNotEquals(secret, "JBSWY3DPEHPK3PXP"); // the old hardcoded public secret
    assertMatch(r.body.provisioning_uri, /^otpauth:\/\/totp\//);
    assert(r.body.qr_code_base64.startsWith("data:image/svg+xml"));
    assertEquals((await hit(api, "/api/v1/security/mfa/status/", { cookies: jar })).body.is_pending, true);

    const bad = await hit(api, "/api/v1/security/mfa/confirm/", { method: "POST", cookies: jar, body: { code: "000000" } });
    assertEquals(bad.status, 400);
    assertEquals((await hit(api, "/api/v1/security/mfa/status/", { cookies: jar })).body.is_enabled, false);
  });

  await t.step("a second setup replaces the abandoned unverified factor", async () => {
    const r = await hit(api, "/api/auth/mfa/setup/", { method: "POST", cookies: jar });
    assertEquals(r.status, 200);
    assertNotEquals(r.body.secret, secret);
    secret = r.body.secret;
    assertEquals(ww.factors.get(A.user.id)!.length, 1);
  });

  await t.step("confirm with the authenticator code: enabled, 10 hashed recovery codes, session upgraded to aal2", async () => {
    const r = await hit(api, "/api/v1/security/mfa/confirm/", { method: "POST", cookies: jar, body: { code: await totp(secret) } });
    assertEquals(r.status, 200, JSON.stringify(r.body));
    recoveryCodes = r.body.recovery_codes;
    assertEquals(recoveryCodes.length, 10);
    assertEquals(new Set(recoveryCodes).size, 10);
    const stored = await w.rows<{ code_hash: string }>(`SELECT code_hash FROM public.accounts_mfarecoverycode WHERE user_id = $1`, [A.user.id]);
    assertEquals(stored.length, 10);
    assert(stored.every((s) => /^[0-9a-f]{64}$/.test(s.code_hash)), "codes stored as SHA-256, never in clear");
    const oldAccess = jar["sb-access-token"];
    applyCookies(jar, r.setCookies);
    assertNotEquals(jar["sb-access-token"], oldAccess);
    // The pre-2FA (aal1) token is no longer accepted for this user.
    assertEquals((await hit(api, `${brandA}/metrics`, { cookies: { "sb-access-token": oldAccess } })).status, 401);
    const st = await hit(api, "/api/v1/security/mfa/status/", { cookies: jar });
    assertEquals([st.body.is_enabled, st.body.unused_recovery_codes_count], [true, 10]);
    const [acct] = await w.rows<{ mfa_enabled: boolean }>(`SELECT mfa_enabled FROM public.accounts_user WHERE id = $1`, [A.user.id]);
    assertEquals(acct.mfa_enabled, true);
  });

  await t.step("login with password only -> mfa_required, NO session cookie; pending cookie cannot read data", async () => {
    const r = await signIn(A.user.email, A.password);
    assertEquals(r.status, 200);
    assertEquals(r.body.mfa_required, true);
    assertEquals(r.body.user, undefined);
    assertEquals(cookieValue(r.setCookies, "sb-access-token"), null);
    assertEquals(cookieValue(r.setCookies, "sessionid"), null);
    assert(r.jar["sb-mfa-pending"]);
    assertEquals((await hit(api, `${brandA}/metrics`, { cookies: r.jar })).status, 401);
    assertEquals((await hit(me, "/api/auth/me", { cookies: r.jar })).status, 401);
    // Even presenting the aal1 token as the session cookie is refused.
    assertEquals((await hit(api, `${brandA}/metrics`, { cookies: { "sb-access-token": r.jar["sb-mfa-pending"] } })).status, 401);
    // ...and the Edge Functions refuse it too (proxy and direct).
    assertEquals((await hit(fnProxy, "/api/fn/shopify-sync", { method: "POST", cookies: { "sb-access-token": r.jar["sb-mfa-pending"] }, body: {} }, { name: "shopify-sync" })).status, 401);
    const direct = await ww.fetch("http://fake-supabase.test/functions/v1/shopify-sync", {
      method: "POST",
      headers: { Authorization: `Bearer ${r.jar["sb-mfa-pending"]}`, "Content-Type": "application/json" },
      body: JSON.stringify({ workspace_id: A.workspace_id, brand_id: A.brand_id }),
    });
    assertEquals(direct.status, 401);
    assertMatch((await direct.json()).error, /Two-factor/);
  });

  await t.step("mfa verify: wrong code 400; right code -> session cookies, pending cleared, data readable", async () => {
    const r = await signIn(A.user.email, A.password);
    const bad = await hit(api, "/api/v1/auth/mfa/verify/", { method: "POST", cookies: r.jar, body: { code: "123456" } });
    assertEquals(bad.status, 400);
    const ok = await hit(api, "/api/v1/auth/mfa/verify/", { method: "POST", cookies: r.jar, body: { code: await totp(secret) } });
    assertEquals(ok.status, 200, JSON.stringify(ok.body));
    assertEquals(ok.body.workspaces[0].slug, A.slug);
    const j = applyCookies({ ...r.jar }, ok.setCookies);
    assertEquals(j["sb-mfa-pending"], undefined);
    assert(j["sb-access-token"] && j.sessionid);
    assertEquals((await hit(api, `${brandA}/metrics`, { cookies: j })).status, 200);
    assertEquals((await hit(me, "/api/auth/me", { cookies: j })).status, 200);
    jar = j;
  });

  await t.step("mfa verify without a pending login -> 401", async () => {
    assertEquals((await hit(api, "/api/v1/auth/mfa/verify/", { method: "POST", body: { code: "123456" } })).status, 401);
  });

  await t.step("regenerate recovery codes needs the password; old codes stop working", async () => {
    assertEquals((await hit(api, "/api/v1/security/mfa/recovery-codes/regenerate/", { method: "POST", cookies: jar, body: { password: "wrong" } })).status, 400);
    const r = await hit(api, "/api/v1/security/mfa/recovery-codes/regenerate/", { method: "POST", cookies: jar, body: { password: A.password } });
    assertEquals(r.status, 200);
    assertEquals(r.body.recovery_codes.length, 10);
    const old = recoveryCodes[0];
    recoveryCodes = r.body.recovery_codes;
    const p = await signIn(A.user.email, A.password);
    assertEquals((await hit(api, "/api/v1/auth/mfa/recovery/", { method: "POST", cookies: p.jar, body: { recovery_code: old } })).status, 400);
  });

  await t.step("recovery code sign-in: works once (lower-case, no dash ok), turns 2FA off", async () => {
    const p = await signIn(A.user.email, A.password);
    const code = recoveryCodes[3].toLowerCase().replace("-", "");
    const r = await hit(api, "/api/v1/auth/mfa/recovery/", { method: "POST", cookies: p.jar, body: { recovery_code: code } });
    assertEquals(r.status, 200, JSON.stringify(r.body));
    assertMatch(r.body.message, /turned off/);
    const j = applyCookies({ ...p.jar }, r.setCookies);
    assertEquals((await hit(api, `${brandA}/metrics`, { cookies: j })).status, 200);
    assertEquals((await hit(api, "/api/v1/security/mfa/status/", { cookies: j })).body.is_enabled, false);
    assertEquals(await w.count("accounts_mfarecoverycode", "user_id = $1", [A.user.id]), 0);
    // password-only login works again
    const again = await signIn(A.user.email, A.password);
    assert(again.jar["sb-access-token"]);
    jar = again.jar;
  });

  await t.step("disable: needs password AND current code; then password-only login works", async () => {
    // re-enrol
    const s = await hit(api, "/api/v1/security/mfa/setup/", { method: "POST", cookies: jar });
    secret = s.body.secret;
    const c = await hit(api, "/api/v1/security/mfa/confirm/", { method: "POST", cookies: jar, body: { code: await totp(secret) } });
    applyCookies(jar, c.setCookies);
    assertEquals((await hit(api, "/api/v1/security/mfa/setup/", { method: "POST", cookies: jar })).status, 409);

    assertEquals((await hit(api, "/api/v1/security/mfa/disable/", { method: "POST", cookies: jar, body: { password: "wrong", code: await totp(secret) } })).status, 400);
    assertEquals((await hit(api, "/api/v1/security/mfa/disable/", { method: "POST", cookies: jar, body: { password: A.password, code: "000000" } })).status, 400);
    assertEquals((await hit(api, "/api/v1/security/mfa/status/", { cookies: jar })).body.is_enabled, true);

    const r = await hit(api, "/api/v1/security/mfa/disable/", { method: "POST", cookies: jar, body: { password: A.password, code: await totp(secret) } });
    assertEquals(r.status, 200, JSON.stringify(r.body));
    assertEquals(ww.factors.get(A.user.id)!.length, 0);
    const again = await signIn(A.user.email, A.password);
    assert(again.jar["sb-access-token"]);
    assertEquals(again.body.mfa_required, undefined);
    jar = again.jar;
  });

  // ── password reset ────────────────────────────────────────────────────────
  await t.step("reset request: same answer for known and unknown email; link targets /reset-password on the requesting origin", async () => {
    const known = await hit(api, "/api/auth/password-reset/", { method: "POST", body: { email: A.user.email } });
    const unknown = await hit(api, "/api/auth/password-reset/", { method: "POST", body: { email: "nobody@example.test" } });
    assertEquals([known.status, unknown.status], [200, 200]);
    assertEquals(known.body, unknown.body);
    const req = ww.recoverRequests.find((r) => r.email === A.user.email)!;
    assertEquals(req.redirect_to, "http://localhost:3000/reset-password"); // the origin the request came in on
    assertEquals((await hit(api, "/api/auth/password-reset/", { method: "POST", body: { email: "not-an-email" } })).status, 400);
  });

  await t.step("reset confirm: a normal session token cannot reset; recovery-link token can, and signs out everywhere", async () => {
    const normal = jar["sb-access-token"];
    assertEquals((await hit(api, "/api/auth/password-reset/confirm/", { method: "POST", body: { access_token: normal, password: "new-password-123", confirm_password: "new-password-123" } })).status, 400);
    assertEquals((await hit(api, "/api/auth/password-reset/confirm/", { method: "POST", body: { access_token: "garbage", password: "new-password-123" } })).status, 400);

    const rec = ww.recoveryLinkSession(A.user.email);
    assertEquals((await hit(api, "/api/auth/password-reset/confirm/", { method: "POST", body: { access_token: rec.access_token, password: "short", confirm_password: "short" } })).status, 400);
    assertEquals((await hit(api, "/api/auth/password-reset/confirm/", { method: "POST", body: { access_token: rec.access_token, password: "new-password-123", confirm_password: "different-123" } })).status, 400);
    const ok = await hit(api, "/api/auth/password-reset/confirm/", { method: "POST", body: { access_token: rec.access_token, password: "new-password-123", confirm_password: "new-password-123" } });
    assertEquals(ok.status, 200, JSON.stringify(ok.body));

    assertEquals((await hit(api, `${brandA}/metrics`, { cookies: { "sb-access-token": normal } })).status, 401, "old sessions revoked");
    assertEquals((await signIn(A.user.email, A.password)).status, 400, "old password rejected");
    const fresh = await signIn(A.user.email, "new-password-123");
    assertEquals(fresh.status, 200);
    jar = fresh.jar;
    A.password = "new-password-123";
  });

  // ── invitations ───────────────────────────────────────────────────────────
  const B = await ww.tenant("invitee@example.test", "Invitee Home");
  const C = await ww.tenant("other@example.test", "Other Home");
  let inviteUrl = "";

  await t.step("invite create: owner gets a one-time link; only a hash is stored", async () => {
    const r = await hit(api, `/api/w/${A.slug}/invites/`, { method: "POST", cookies: jar, body: { email: "Invitee@Example.test", role: "analyst" } });
    assertEquals(r.status, 200, JSON.stringify(r.body));
    inviteUrl = r.body.invite_url;
    assertMatch(inviteUrl, /^\/invites\/accept\?token=[A-Za-z0-9_-]{40,}$/);
    assertNotEquals(inviteUrl, "/invites/accept?token=125east_demo_invite");
    const token = inviteUrl.split("token=")[1];
    const [row] = await w.rows<{ email: string; role: string; token_hash: string }>(`SELECT email, role, token_hash FROM public.tenancy_invite WHERE workspace_id = $1`, [A.workspace_id]);
    assertEquals([row.email, row.role], ["invitee@example.test", "analyst"]);
    assertNotEquals(row.token_hash, token);
  });

  await t.step("invite create: validation and permissions", async () => {
    assertEquals((await hit(api, `/api/w/${A.slug}/invites/`, { method: "POST", cookies: jar, body: { email: "bad", role: "viewer" } })).status, 400);
    assertEquals((await hit(api, `/api/w/${A.slug}/invites/`, { method: "POST", cookies: jar, body: { email: "x@example.test", role: "god" } })).status, 400);
    // non-member
    const cj = (await signIn(C.user.email, C.password)).jar;
    assertEquals((await hit(api, `/api/w/${A.slug}/invites/`, { method: "POST", cookies: cj, body: { email: "y@example.test" } })).status, 404);
  });

  await t.step("invite accept: wrong account 403; invited account joins with the invited role; link is single-use", async () => {
    const token = inviteUrl.split("token=")[1];
    const cj = (await signIn(C.user.email, C.password)).jar;
    const wrong = await hit(api, "/api/w/invites/accept/", { method: "POST", cookies: cj, body: { token } });
    assertEquals(wrong.status, 403);
    assertEquals(await w.count("tenancy_workspacemember", "workspace_id = $1 AND user_id = $2", [A.workspace_id, C.user.id]), 0);

    const bj = (await signIn(B.user.email, B.password)).jar;
    const ok = await hit(api, "/api/w/invites/accept/", { method: "POST", cookies: bj, body: { token } });
    assertEquals(ok.status, 200, JSON.stringify(ok.body));
    assertEquals(ok.body.workspace_slug, A.slug);
    const [m] = await w.rows<{ role: string }>(`SELECT role FROM public.tenancy_workspacemember WHERE workspace_id = $1 AND user_id = $2`, [A.workspace_id, B.user.id]);
    assertEquals(m.role, "analyst");
    // B can now read A's data with the analyst role, but cannot write integrations
    assertEquals((await hit(api, `${brandA}/metrics`, { cookies: bj })).status, 200);
    assertEquals((await hit(api, `${brandA}/integrations/`, { method: "POST", cookies: bj, body: { provider: "shopify", credentials: { a: "b" } } })).status, 403);
    // reuse
    assertEquals((await hit(api, "/api/w/invites/accept/", { method: "POST", cookies: bj, body: { token } })).status, 400);
    // members list shows B; re-inviting a member is refused
    const members = await hit(api, `/api/w/${A.slug}/members/`, { cookies: jar });
    assert(members.body.some((x: any) => x.user.email === B.user.email));
    assertEquals((await hit(api, `/api/w/${A.slug}/invites/`, { method: "POST", cookies: jar, body: { email: B.user.email } })).status, 409);
  });

  await t.step("invite accept: expired or unknown token -> 400", async () => {
    const r = await hit(api, `/api/w/${A.slug}/invites/`, { method: "POST", cookies: jar, body: { email: C.user.email, role: "viewer" } });
    const token = r.body.invite_url.split("token=")[1];
    await w.db.query(`UPDATE public.tenancy_invite SET expires_at = now() - interval '1 minute' WHERE email = $1`, [C.user.email]);
    const cj = (await signIn(C.user.email, C.password)).jar;
    assertEquals((await hit(api, "/api/w/invites/accept/", { method: "POST", cookies: cj, body: { token } })).status, 400);
    assertEquals((await hit(api, "/api/w/invites/accept/", { method: "POST", cookies: cj, body: { token: "nope" } })).status, 400);
  });

  await t.step("analyst cannot invite; only an owner can invite an owner", async () => {
    const bj = (await signIn(B.user.email, B.password)).jar;
    assertEquals((await hit(api, `/api/w/${A.slug}/invites/`, { method: "POST", cookies: bj, body: { email: "z@example.test" } })).status, 403);
    await w.addMember(A.workspace_id, C.user.id, "admin");
    const cj = (await signIn(C.user.email, C.password)).jar;
    assertEquals((await hit(api, `/api/w/${A.slug}/invites/`, { method: "POST", cookies: cj, body: { email: "z@example.test", role: "owner" } })).status, 403);
    // Starter plan: 3 members in total. This workspace already has more, so the plan limit now refuses the invite.
    const capped = await hit(api, `/api/w/${A.slug}/invites/`, { method: "POST", cookies: cj, body: { email: "z@example.test", role: "admin" } });
    assertEquals(capped.status, 409, JSON.stringify(capped.body));
    assert(String(capped.body.error).includes("allows 3 members"), capped.body.error);
    // On a larger plan the same invite succeeds.
    await w.db.query("UPDATE public.billing_subscription SET max_members = 10 WHERE workspace_id = $1", [A.workspace_id]);
    assertEquals((await hit(api, `/api/w/${A.slug}/invites/`, { method: "POST", cookies: cj, body: { email: "z@example.test", role: "admin" } })).status, 200);
  });

  // ── browser -> Edge Function proxy ────────────────────────────────────────
  await t.step("/api/fn proxy: forwards the cookie session JWT; unknown function 404; no session 401", async () => {
    assertEquals((await hit(fnProxy, "/api/fn/shopify-sync", { method: "POST", body: {} }, { name: "shopify-sync" })).status, 401);
    assertEquals((await hit(fnProxy, "/api/fn/webhook-shopify", { method: "POST", cookies: jar, body: {} }, { name: "webhook-shopify" })).status, 404);
    const r = await hit(fnProxy, "/api/fn/shopify-sync", { method: "POST", cookies: jar, body: { workspace_id: A.workspace_id, brand_id: A.brand_id } }, { name: "shopify-sync" });
    // Reached the real Edge Function, which authenticated the user and found no Shopify integration.
    assertEquals(r.status, 404, JSON.stringify(r.body));
    assertEquals(r.body.success, false);
    assertMatch(r.body.error, /integration not configured/);
    assertEquals(ww.edgeCalls.at(-1)!.auth, `Bearer ${jar["sb-access-token"]}`);
    // cross-tenant through the proxy is still refused by the function
    const cj = (await signIn(C.user.email, C.password)).jar;
    const x = await hit(fnProxy, "/api/fn/shopify-sync", { method: "POST", cookies: cj, body: { workspace_id: B.workspace_id, brand_id: B.brand_id } }, { name: "shopify-sync" });
    assertEquals(x.status, 403);
  });

  ww.restore();
  await w.close();
}});
