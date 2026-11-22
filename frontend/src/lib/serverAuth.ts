import { NextRequest, NextResponse } from "next/server";
import type { Session, SupabaseClient, User as AuthUser } from "@supabase/supabase-js";
import { getAdminClient } from "./supabaseServer";
import { getPublicAuthClient } from "./serverlessAuth";
import { RouteError } from "./routeError";
import { hasVerifiedTotp, verifiedJwtClaims } from "./gotrue";

export { RouteError };

/**
 * Server-side session handling for the Next.js API routes (Vercel serverless functions).
 *
 * Identity provider: Supabase Auth. /api/auth/login stores the Supabase access + refresh token in
 * HTTP-only cookies (`sb-access-token`, `sb-refresh-token`; `sessionid` mirrors the access token so
 * src/middleware.ts can gate pages on cookie presence). Every data route must call `requireSession`
 * before it touches the service-role client, and `requireTenant` before it reads brand data.
 */

export const ACCESS_COOKIE = "sb-access-token";
export const REFRESH_COOKIE = "sb-refresh-token";
export const PAGE_GATE_COOKIE = "sessionid";
/** Password-verified but not yet 2FA-verified login (aal1), held only until /api/v1/auth/mfa/verify. */
export const MFA_PENDING_ACCESS = "sb-mfa-pending";
export const MFA_PENDING_REFRESH = "sb-mfa-pending-rt";

const COOKIE_MAX_AGE = 60 * 60 * 24 * 7; // the refresh token outlives the 1h access token

export type Role = "owner" | "admin" | "analyst" | "viewer";
export const ADMIN_ROLES: Role[] = ["owner", "admin"];

export interface SessionContext {
  authUser: AuthUser;
  /** accounts_user.id: the id tenancy_workspacemember.user_id references. */
  userId: string;
  isSuperuser: boolean;
  accessToken: string;
  /** Set when the access token was refreshed; pass to `withSessionCookies` on the response. */
  refreshed: Session | null;
  /** Authenticator assurance level of the token: aal2 after a TOTP verification. */
  aal: string;
  mfaEnabled: boolean;
}

export interface TenantContext {
  workspaceId: string;
  role: Role;
  brand: { id: string; name: string; currency: string; timezone: string } | null;
}


export function setSessionCookies(res: NextResponse, session: Pick<Session, "access_token" | "refresh_token">) {
  const opts = {
    path: "/",
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    maxAge: COOKIE_MAX_AGE,
  };
  res.cookies.set(ACCESS_COOKIE, session.access_token, opts);
  res.cookies.set(REFRESH_COOKIE, session.refresh_token, opts);
  res.cookies.set(PAGE_GATE_COOKIE, session.access_token, opts);
}

export function clearSessionCookies(res: NextResponse) {
  for (const name of [ACCESS_COOKIE, REFRESH_COOKIE, PAGE_GATE_COOKIE, MFA_PENDING_ACCESS, MFA_PENDING_REFRESH, "csrftoken"]) {
    res.cookies.delete(name);
  }
}

const PENDING_MAX_AGE = 60 * 10;

export function setMfaPendingCookies(res: NextResponse, session: Pick<Session, "access_token" | "refresh_token">) {
  const opts = { path: "/", httpOnly: true, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production", maxAge: PENDING_MAX_AGE };
  res.cookies.set(MFA_PENDING_ACCESS, session.access_token, opts);
  res.cookies.set(MFA_PENDING_REFRESH, session.refresh_token, opts);
  for (const name of [ACCESS_COOKIE, REFRESH_COOKIE, PAGE_GATE_COOKIE]) res.cookies.delete(name);
}

export function clearMfaPendingCookies(res: NextResponse) {
  res.cookies.delete(MFA_PENDING_ACCESS);
  res.cookies.delete(MFA_PENDING_REFRESH);
}

export function withSessionCookies(res: NextResponse, ctx: Pick<SessionContext, "refreshed">): NextResponse {
  if (ctx.refreshed) setSessionCookies(res, ctx.refreshed);
  return res;
}

function readAccessToken(req: NextRequest): string | null {
  const header = req.headers.get("authorization") || "";
  const bearer = /^Bearer\s+(\S+)$/i.exec(header)?.[1];
  return bearer || req.cookies.get(ACCESS_COOKIE)?.value || req.cookies.get(PAGE_GATE_COOKIE)?.value || null;
}

/**
 * Validates the caller's Supabase session (refreshing an expired access token from the refresh
 * cookie) and maps it to the active accounts_user row. Throws RouteError(401/403).
 */
export async function requireSession(req: NextRequest, admin: SupabaseClient = getAdminClient()): Promise<SessionContext> {
  let accessToken = readAccessToken(req);
  let refreshed: Session | null = null;
  let authUser: AuthUser | null = null;

  if (accessToken) {
    const { data, error } = await admin.auth.getUser(accessToken);
    if (!error && data?.user) authUser = data.user;
  }

  if (!authUser) {
    const refreshToken = req.cookies.get(REFRESH_COOKIE)?.value;
    if (refreshToken) {
      const { data, error } = await getPublicAuthClient().auth.refreshSession({ refresh_token: refreshToken });
      if (!error && data?.session && data.user) {
        refreshed = data.session;
        accessToken = data.session.access_token;
        authUser = data.user;
      }
    }
  }

  if (!authUser || !accessToken) throw new RouteError(401, "Authentication required");

  // A user with a verified TOTP factor must present an aal2 token: a password-only session is not enough.
  const aal = String(verifiedJwtClaims(accessToken).aal || "aal1");
  const mfaEnabled = hasVerifiedTotp(authUser as any);
  if (mfaEnabled && aal !== "aal2") throw new RouteError(401, "Two-factor verification required");

  // Users provisioned by handle_new_auth_user() share the auth.users id; older (Django-era) rows are matched by email.
  let { data: account } = await admin
    .from("accounts_user")
    .select("id, is_active, is_superuser")
    .eq("id", authUser.id)
    .maybeSingle();
  if (!account && authUser.email) {
    ({ data: account } = await admin
      .from("accounts_user")
      .select("id, is_active, is_superuser")
      .eq("email", authUser.email.toLowerCase())
      .maybeSingle());
  }
  if (!account) throw new RouteError(403, "No 125 East account is linked to this login");
  if (account.is_active === false) throw new RouteError(403, "Account suspended");

  return { authUser, userId: account.id, isSuperuser: Boolean(account.is_superuser), accessToken, refreshed, aal, mfaEnabled };
}

/**
 * Resolves the workspace (by slug) and optional brand, and verifies the caller is a member with one of
 * `allowedRoles` and that the brand belongs to that workspace. Unknown workspace and non-membership both
 * answer 404/403 without revealing which.
 */
export async function requireTenant(
  admin: SupabaseClient,
  session: SessionContext,
  workspaceSlug: string,
  brandId: string | null,
  allowedRoles: Role[] = ["owner", "admin", "analyst", "viewer"],
): Promise<TenantContext> {
  const { data: ws } = await admin.from("tenancy_workspace").select("id").eq("slug", workspaceSlug).maybeSingle();
  if (!ws) throw new RouteError(404, "Workspace not found");

  const { data: member } = await admin
    .from("tenancy_workspacemember")
    .select("role")
    .eq("workspace_id", ws.id)
    .eq("user_id", session.userId)
    .maybeSingle();
  if (!member) throw new RouteError(404, "Workspace not found");
  if (!allowedRoles.includes(member.role as Role)) {
    throw new RouteError(403, `Your role (${member.role}) cannot perform this action`);
  }

  let brand: TenantContext["brand"] = null;
  if (brandId) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(brandId)) {
      throw new RouteError(404, "Brand not found");
    }
    const { data: b } = await admin
      .from("tenancy_brand")
      .select("id, name, currency, timezone")
      .eq("id", brandId)
      .eq("workspace_id", ws.id)
      .maybeSingle();
    if (!b) throw new RouteError(404, "Brand not found");
    brand = b;
  }

  return { workspaceId: ws.id, role: member.role as Role, brand };
}

export function errorJson(err: unknown): NextResponse {
  if (err instanceof RouteError) return NextResponse.json({ error: err.message }, { status: err.status });
  console.error("API route error:", (err as Error)?.message);
  return NextResponse.json({ error: "Internal server error" }, { status: 500 });
}
