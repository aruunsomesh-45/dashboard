import { createHash, randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getAdminClient } from "./supabaseServer";
import { getAuthPayloadForUser, getPublicAuthClient } from "./serverlessAuth";
import {
  ADMIN_ROLES,
  MFA_PENDING_ACCESS,
  MFA_PENDING_REFRESH,
  RouteError,
  SessionContext,
  clearMfaPendingCookies,
  requireSession,
  requireTenant,
  setSessionCookies,
  withSessionCookies,
} from "./serverAuth";
import { Factor, gotrue, totpFactors, verifiedJwtClaims, verifyTotp } from "./gotrue";

/**
 * Account features on Supabase Auth: TOTP two-factor auth (+ recovery codes), password reset and
 * workspace invitations. Dispatched from the catch-all API route.
 */

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const normCode = (c: string) => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

async function body(req: NextRequest): Promise<Record<string, any>> {
  const b = await req.json().catch(() => null);
  return b && typeof b === "object" && !Array.isArray(b) ? b : {};
}

/** Origin the user is actually on (Supabase only honours redirect targets in its allow-list). */
function siteOrigin(req: NextRequest): string {
  return (req.nextUrl.origin || process.env.NEXT_PUBLIC_SITE_URL || "").replace(/\/+$/, "");
}

// ─── recovery codes ───────────────────────────────────────────────────────────

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

function newRecoveryCode(): string {
  const bytes = randomBytes(8);
  const chars = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

async function issueRecoveryCodes(admin: SupabaseClient, userId: string): Promise<string[]> {
  const codes = Array.from({ length: 10 }, newRecoveryCode);
  const { error: delErr } = await admin.from("accounts_mfarecoverycode").delete().eq("user_id", userId);
  if (delErr) throw new Error(delErr.message);
  const { error } = await admin
    .from("accounts_mfarecoverycode")
    .insert(codes.map((c) => ({ user_id: userId, code_hash: sha256(normCode(c)) })));
  if (error) throw new Error(error.message);
  return codes;
}

async function unusedCodeCount(admin: SupabaseClient, userId: string): Promise<number> {
  const { count } = await admin
    .from("accounts_mfarecoverycode")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .is("used_at", null);
  return count || 0;
}

async function removeAllTotp(admin: SupabaseClient, authUserId: string, factors: Factor[]) {
  for (const f of factors) {
    const { error } = await admin.auth.admin.mfa.deleteFactor({ id: f.id, userId: authUserId });
    if (error) throw new Error(`Could not remove authenticator: ${error.message}`);
  }
}

async function setMfaFlag(admin: SupabaseClient, userId: string, enabled: boolean) {
  await admin.from("accounts_user").update({ mfa_enabled: enabled }).eq("id", userId);
}

/** Confirms the caller's current password without disturbing their session (the probe session is revoked). */
async function checkPassword(admin: SupabaseClient, email: string, password: string) {
  if (!password) throw new RouteError(400, "Enter your current password");
  const { data, error } = await getPublicAuthClient().auth.signInWithPassword({ email, password });
  if (error || !data.session) throw new RouteError(400, "Incorrect password");
  await admin.auth.admin.signOut(data.session.access_token, "local").catch(() => undefined);
}

/** Fresh factor list from GoTrue for the current token (getUser includes factors). */
async function currentFactors(admin: SupabaseClient, token: string): Promise<Factor[]> {
  const { data } = await admin.auth.getUser(token);
  return totpFactors(data?.user as any);
}

// ─── two-factor: settings (signed in) ─────────────────────────────────────────

async function mfaStatus(admin: SupabaseClient, s: SessionContext) {
  const factors = await currentFactors(admin, s.accessToken);
  const verified = factors.find((f) => f.status === "verified");
  return {
    is_enabled: Boolean(verified),
    is_pending: !verified && factors.some((f) => f.status === "unverified"),
    unused_recovery_codes_count: verified ? await unusedCodeCount(admin, s.userId) : 0,
    confirmed_at: verified?.updated_at || null,
  };
}

async function mfaSetup(admin: SupabaseClient, s: SessionContext) {
  const factors = await currentFactors(admin, s.accessToken);
  if (factors.some((f) => f.status === "verified")) {
    throw new RouteError(409, "Two-factor authentication is already enabled");
  }
  // Abandoned set-ups leave unverified factors behind; clear them so enrolment always starts clean.
  await removeAllTotp(admin, s.authUser.id, factors.filter((f) => f.status === "unverified"));

  const r = await gotrue<{ id: string; totp: { qr_code: string; secret: string; uri: string } }>("/factors", {
    method: "POST",
    token: s.accessToken,
    body: { factor_type: "totp", friendly_name: `125 East ${new Date().toISOString()}`, issuer: "125 East" },
  });
  if (r.error || !r.data) {
    throw new RouteError(r.status === 422 || r.status === 403 ? 400 : 502, `Could not start two-factor setup: ${r.error}`);
  }
  return { secret: r.data.totp.secret, provisioning_uri: r.data.totp.uri, qr_code_base64: r.data.totp.qr_code };
}

async function mfaConfirm(admin: SupabaseClient, s: SessionContext, req: NextRequest) {
  const { code } = await body(req);
  if (!/^\d{6}$/.test(String(code || "").replace(/\s+/g, ""))) throw new RouteError(400, "Enter the 6-digit code from your authenticator app");
  const pending = (await currentFactors(admin, s.accessToken)).filter((f) => f.status === "unverified");
  const factor = pending.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
  if (!factor) throw new RouteError(400, "Start two-factor setup first");

  const session = await verifyTotp(s.accessToken, factor.id, code);
  await setMfaFlag(admin, s.userId, true);
  const recovery_codes = await issueRecoveryCodes(admin, s.userId);
  const res = NextResponse.json({ success: true, recovery_codes });
  setSessionCookies(res, session); // the old aal1 token would now be rejected
  return res;
}

async function mfaDisable(admin: SupabaseClient, s: SessionContext, req: NextRequest) {
  const { password, code } = await body(req);
  const factors = await currentFactors(admin, s.accessToken);
  const verified = factors.find((f) => f.status === "verified");
  if (!verified) throw new RouteError(400, "Two-factor authentication is not enabled");
  await checkPassword(admin, s.authUser.email || "", String(password || ""));
  await verifyTotp(s.accessToken, verified.id, String(code || ""));
  await removeAllTotp(admin, s.authUser.id, factors);
  await admin.from("accounts_mfarecoverycode").delete().eq("user_id", s.userId);
  await setMfaFlag(admin, s.userId, false);
  return { success: true };
}

async function mfaRegenerate(admin: SupabaseClient, s: SessionContext, req: NextRequest) {
  const { password } = await body(req);
  if (!s.mfaEnabled) throw new RouteError(400, "Two-factor authentication is not enabled");
  await checkPassword(admin, s.authUser.email || "", String(password || ""));
  return { recovery_codes: await issueRecoveryCodes(admin, s.userId) };
}

// ─── two-factor: login challenge (password verified, aal1 pending cookie) ────

async function pendingLogin(admin: SupabaseClient, req: NextRequest) {
  const access = req.cookies.get(MFA_PENDING_ACCESS)?.value;
  const refresh = req.cookies.get(MFA_PENDING_REFRESH)?.value;
  if (!access || !refresh) throw new RouteError(401, "Your sign-in expired. Please sign in again.");
  const { data, error } = await admin.auth.getUser(access);
  if (error || !data?.user) throw new RouteError(401, "Your sign-in expired. Please sign in again.");
  return { access, refresh, user: data.user };
}

async function mfaLoginVerify(admin: SupabaseClient, req: NextRequest) {
  const { code } = await body(req);
  const p = await pendingLogin(admin, req);
  const factor = totpFactors(p.user as any).find((f) => f.status === "verified");
  if (!factor) throw new RouteError(400, "Two-factor authentication is not enabled for this account");
  const session = await verifyTotp(p.access, factor.id, String(code || ""));
  const res = NextResponse.json({ ...(await getAuthPayloadForUser(p.user)), redirect: "/dashboard" });
  clearMfaPendingCookies(res);
  setSessionCookies(res, session);
  return res;
}

/** A recovery code replaces the authenticator once: it signs the user in and turns 2FA off (re-enrol after). */
async function mfaLoginRecovery(admin: SupabaseClient, req: NextRequest) {
  const { recovery_code } = await body(req);
  const p = await pendingLogin(admin, req);
  const { data: account } = await admin.from("accounts_user").select("id").eq("id", p.user.id).maybeSingle();
  const userId = account?.id;
  if (!userId) throw new RouteError(400, "Invalid recovery code");

  const hash = sha256(normCode(String(recovery_code || "")));
  const { data: used } = await admin
    .from("accounts_mfarecoverycode")
    .update({ used_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("code_hash", hash)
    .is("used_at", null)
    .select("id");
  if (!used?.length) throw new RouteError(400, "Invalid recovery code");

  await removeAllTotp(admin, p.user.id, totpFactors(p.user as any));
  await admin.from("accounts_mfarecoverycode").delete().eq("user_id", userId);
  await setMfaFlag(admin, userId, false);

  // With no verified factor left, the password-verified (aal1) session is a full session.
  const res = NextResponse.json({
    ...(await getAuthPayloadForUser(p.user)),
    redirect: "/settings",
    message: "Signed in with a recovery code. Two-factor authentication was turned off: set it up again in Settings.",
  });
  clearMfaPendingCookies(res);
  setSessionCookies(res, { access_token: p.access, refresh_token: p.refresh });
  return res;
}

// ─── password reset ───────────────────────────────────────────────────────────

async function passwordResetRequest(req: NextRequest) {
  const email = String((await body(req)).email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new RouteError(400, "Enter a valid email address");
  const { error } = await getPublicAuthClient().auth.resetPasswordForEmail(email, {
    redirectTo: `${siteOrigin(req)}/reset-password`,
  });
  if (error && /rate limit|too many/i.test(error.message)) {
    throw new RouteError(429, "Too many reset requests. Please wait a few minutes and try again.");
  }
  // Same answer whether or not the account exists (no account enumeration).
  return { message: "If an account exists for that email, a password reset link has been sent." };
}

const RECOVERY_AMR = new Set(["recovery", "otp", "magiclink"]);

async function passwordResetConfirm(admin: SupabaseClient, req: NextRequest) {
  const { access_token, password, confirm_password } = await body(req);
  const pw = String(password || "");
  if (pw.length < 8) throw new RouteError(400, "Password must be at least 8 characters");
  if (confirm_password !== undefined && pw !== confirm_password) throw new RouteError(400, "Passwords do not match");
  if (!access_token) throw new RouteError(400, "This reset link is invalid or has expired");

  const { data, error } = await admin.auth.getUser(String(access_token));
  if (error || !data?.user) throw new RouteError(400, "This reset link is invalid or has expired");
  // Only a session created by the emailed recovery link may set a password without the old one.
  const amr: { method?: string }[] = verifiedJwtClaims(String(access_token)).amr || [];
  if (!amr.some((m) => RECOVERY_AMR.has(String(m?.method)))) {
    throw new RouteError(400, "This reset link is invalid or has expired");
  }

  const { error: upErr } = await admin.auth.admin.updateUserById(data.user.id, { password: pw });
  if (upErr) throw new RouteError(400, upErr.message);
  // Sign out every session (including the recovery one): the user logs in with the new password.
  await admin.auth.admin.signOut(String(access_token), "global").catch(() => undefined);
  return { message: "Your password has been updated. Please sign in." };
}

// ─── invitations ──────────────────────────────────────────────────────────────

const INVITE_TTL_DAYS = 7;

async function createInvite(admin: SupabaseClient, s: SessionContext, wsSlug: string, req: NextRequest) {
  const tenant = await requireTenant(admin, s, wsSlug, null, ADMIN_ROLES);
  const b = await body(req);
  const email = String(b.email || "").trim().toLowerCase();
  const role = String(b.role || "viewer");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new RouteError(400, "Enter a valid email address");
  if (!["owner", "admin", "analyst", "viewer"].includes(role)) throw new RouteError(400, "Invalid role");
  if (role === "owner" && tenant.role !== "owner") throw new RouteError(403, "Only an owner can invite another owner");

  // Plan member limit: current members plus pending (unaccepted, unexpired) invites.
  const { data: sub } = await admin.from("billing_subscription").select("max_members, plan").eq("workspace_id", tenant.workspaceId).maybeSingle();
  const maxMembers = Number(sub?.max_members ?? 3);
  const [{ count: members }, { count: pending }] = await Promise.all([
    admin.from("tenancy_workspacemember").select("id", { count: "exact", head: true }).eq("workspace_id", tenant.workspaceId),
    admin.from("tenancy_invite").select("id", { count: "exact", head: true }).eq("workspace_id", tenant.workspaceId)
      .is("accepted_at", null).gt("expires_at", new Date().toISOString()),
  ]);
  if ((members ?? 0) + (pending ?? 0) >= maxMembers) {
    throw new RouteError(409, `Your ${sub?.plan ?? "starter"} plan allows ${maxMembers} members. Remove a member or cancel a pending invite to continue.`);
  }

  const { data: existing } = await admin.from("accounts_user").select("id").eq("email", email).maybeSingle();
  if (existing) {
    const { data: member } = await admin
      .from("tenancy_workspacemember")
      .select("id")
      .eq("workspace_id", tenant.workspaceId)
      .eq("user_id", existing.id)
      .maybeSingle();
    if (member) throw new RouteError(409, "This person is already a member of the workspace");
  }

  const token = randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000).toISOString();
  const { error } = await admin.from("tenancy_invite").insert({
    workspace_id: tenant.workspaceId,
    email,
    role,
    token_hash: sha256(token),
    expires_at: expires,
    created_by_id: s.userId,
  });
  if (error) throw new Error(error.message);
  await admin.from("tenancy_auditlog").insert({
    workspace_id: tenant.workspaceId,
    actor_id: s.userId,
    action: "invite_created",
    target: email,
    metadata: { role },
  });
  // The team page prefixes window.location.origin.
  return { invite_url: `/invites/accept?token=${token}`, email, role, expires_at: expires };
}

async function acceptInvite(admin: SupabaseClient, s: SessionContext, req: NextRequest) {
  const token = String((await body(req)).token || "");
  if (!token) throw new RouteError(400, "Invitation token is missing");
  const { data: invite } = await admin
    .from("tenancy_invite")
    .select("id, workspace_id, email, role, expires_at, accepted_at")
    .eq("token_hash", sha256(token))
    .maybeSingle();
  if (!invite || invite.accepted_at || Date.parse(invite.expires_at) <= Date.now()) {
    throw new RouteError(400, "This invitation is invalid, expired or already used");
  }
  // Supabase only issues sessions for confirmed email addresses, so matching the email proves mailbox ownership.
  if (String(invite.email).toLowerCase() !== String(s.authUser.email || "").toLowerCase()) {
    throw new RouteError(403, `This invitation was sent to ${invite.email}. Sign in with that address to accept it.`);
  }

  const { data: member } = await admin
    .from("tenancy_workspacemember")
    .select("id")
    .eq("workspace_id", invite.workspace_id)
    .eq("user_id", s.userId)
    .maybeSingle();
  if (!member) {
    const { error } = await admin
      .from("tenancy_workspacemember")
      .insert({ workspace_id: invite.workspace_id, user_id: s.userId, role: invite.role });
    if (error) throw new Error(error.message);
  }
  await admin.from("tenancy_invite").update({ accepted_at: new Date().toISOString() }).eq("id", invite.id);
  await admin.from("tenancy_auditlog").insert({
    workspace_id: invite.workspace_id,
    actor_id: s.userId,
    action: "invite_accepted",
    target: invite.id,
    metadata: { email: invite.email, role: invite.role, via: "link" },
  });
  const { data: ws } = await admin.from("tenancy_workspace").select("slug").eq("id", invite.workspace_id).maybeSingle();
  return { success: true, workspace_slug: ws?.slug, role: member ? undefined : invite.role };
}

// ─── dispatcher ───────────────────────────────────────────────────────────────

const json = (b: unknown, s: SessionContext) => withSessionCookies(NextResponse.json(b), s);

/** Returns a response when `path` is an account route, otherwise null. */
export async function handleAccountRoute(req: NextRequest, path: string, method: string): Promise<NextResponse | null> {
  const p = path.replace(/\/+$/, "");
  if (method === "POST" && p === "auth/password-reset") return NextResponse.json(await passwordResetRequest(req));
  if (method === "POST" && p === "auth/password-reset/confirm") {
    return NextResponse.json(await passwordResetConfirm(getAdminClient(), req));
  }

  if (method === "POST" && p === "v1/auth/mfa/verify") return mfaLoginVerify(getAdminClient(), req);
  if (method === "POST" && p === "v1/auth/mfa/recovery") return mfaLoginRecovery(getAdminClient(), req);

  const mfa = /^(?:v1\/security|auth)\/mfa\/(status|setup|confirm|disable|recovery-codes\/regenerate)$/.exec(p);
  if (mfa) {
    const admin = getAdminClient();
    const s = await requireSession(req, admin);
    const action = mfa[1];
    if (action === "status" && method === "GET") return json(await mfaStatus(admin, s), s);
    if (method !== "POST") throw new RouteError(405, "Method not allowed");
    if (action === "setup") return json(await mfaSetup(admin, s), s);
    if (action === "confirm") return mfaConfirm(admin, s, req);
    if (action === "disable") return json(await mfaDisable(admin, s, req), s);
    return json(await mfaRegenerate(admin, s, req), s);
  }

  if (method === "POST" && p === "w/invites/accept") {
    const admin = getAdminClient();
    const s = await requireSession(req, admin);
    return json(await acceptInvite(admin, s, req), s);
  }
  const inv = /^w\/([^/]+)\/invites$/.exec(p);
  if (inv && method === "POST" && inv[1] !== "invites") {
    const admin = getAdminClient();
    const s = await requireSession(req, admin);
    return json(await createInvite(admin, s, inv[1], req), s);
  }
  return null;
}

