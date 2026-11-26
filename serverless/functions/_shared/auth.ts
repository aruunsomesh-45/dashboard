import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.48.1";
import { HttpError } from "./http.ts";
import { isCronRequest } from "./cron.ts";
import type { Deps } from "./deps.ts";

export interface AuthenticatedUser {
  id: string;
  email: string;
}

export interface WorkspaceContext {
  workspaceId: string;
  brandId: string;
  role: string;
}

/** Authenticates the caller from the Bearer JWT. Throws 401 when missing/invalid/expired. */
export async function requireAuth(
  req: Request,
  deps: Pick<Deps, "userClient">,
): Promise<{ user: AuthenticatedUser; client: SupabaseClient }> {
  const header = req.headers.get("Authorization") || "";
  if (!/^Bearer\s+\S+/i.test(header)) {
    throw new HttpError(401, "Authentication required: missing Bearer token");
  }
  const client = deps.userClient(req);
  const { data, error } = await client.auth.getUser();
  const user = data?.user;
  if (error || !user) {
    throw new HttpError(401, "Authentication required: invalid or expired session");
  }
  // Users with a verified TOTP factor must present an aal2 token (password-only sessions are rejected).
  if (requiresAal2(user) && jwtAal(header) !== "aal2") {
    throw new HttpError(401, "Two-factor verification required");
  }
  return { user: { id: user.id, email: user.email || "" }, client };
}

/** Who is invoking a sync function: Supabase Cron (shared secret) or a signed-in dashboard user. */
export type SyncCaller =
  | { kind: "cron" }
  | { kind: "user"; user: AuthenticatedUser; client: SupabaseClient };

/**
 * Authenticates a sync call. Runs before the body is read, so bad credentials are a 401 before any 400.
 * A wrong x-cron-secret is a 401 (it never falls through to user auth).
 */
export async function requireSyncCaller(req: Request, deps: Pick<Deps, "userClient">): Promise<SyncCaller> {
  if (isCronRequest(req)) return { kind: "cron" };
  const { user, client } = await requireAuth(req, deps);
  return { kind: "user", user, client };
}

/**
 * Users must be workspace members with the module enabled. Cron calls are pre-filtered in SQL by
 * public.enqueue_scheduled_syncs() (connected integrations, module not disabled for the workspace) and
 * stay bound to the (workspace_id, brand_id) pair because loadIntegration() matches both columns.
 */
export async function authorizeSyncScope(
  caller: SyncCaller,
  workspaceId: string,
  brandId: string,
  moduleKey: string,
): Promise<void> {
  if (caller.kind === "cron") return;
  await requireWorkspaceAccess(caller.client, caller.user.id, workspaceId, brandId);
  await requireModuleAccess(caller.client, caller.user.id, workspaceId, moduleKey);
}

export function requiresAal2(user: { factors?: Array<{ factor_type?: string; status?: string }> | null }): boolean {
  return (user.factors ?? []).some((f) => f?.factor_type === "totp" && f?.status === "verified");
}

/** `aal` claim of a bearer JWT. Only meaningful after auth.getUser() has verified the token. */
export function jwtAal(authorizationHeader: string): string {
  try {
    const token = authorizationHeader.replace(/^Bearer\s+/i, "");
    const part = token.split(".")[1] ?? "";
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    return String(JSON.parse(atob(b64)).aal ?? "aal1");
  } catch {
    return "aal1";
  }
}

/**
 * Verifies membership through the caller's RLS-scoped client. A user who is not a member
 * cannot even see the workspace row, so this cannot be bypassed by guessing IDs.
 * Throws 403 when access is denied.
 *
 * NOTE: tenancy_workspacemember.user_id references accounts_user.id, which is provisioned
 * from auth.users with the same id by handle_new_auth_user().
 */
export async function requireWorkspaceAccess(
  client: SupabaseClient,
  userId: string,
  workspaceId: string,
  brandId: string | null | undefined,
  allowedRoles: string[] = ["owner", "admin", "analyst", "viewer"],
): Promise<WorkspaceContext> {
  const { data: membership, error: memberError } = await client
    .from("tenancy_workspacemember")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .maybeSingle();

  if (memberError || !membership) {
    throw new HttpError(403, "Access denied: not a member of this workspace");
  }
  if (!allowedRoles.includes(membership.role)) {
    throw new HttpError(403, `Access denied: role '${membership.role}' cannot perform this action`);
  }

  if (!brandId) return { workspaceId, brandId: "", role: membership.role };

  const { data: brand, error: brandError } = await client
    .from("tenancy_brand")
    .select("id")
    .eq("id", brandId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();

  if (brandError || !brand) {
    throw new HttpError(403, "Access denied: brand does not belong to this workspace");
  }

  return { workspaceId, brandId, role: membership.role };
}

/**
 * Enforces per-user / workspace module access at the serverless runtime boundary.
 * Checks global platform status, workspace baseline, and user-specific overrides.
 * Bypassed for verified platform super administrators.
 */
export async function requireModuleAccess(
  client: SupabaseClient,
  userId: string,
  workspaceId: string,
  moduleKey: string,
): Promise<void> {
  // 1. Check if user is platform superuser
  const { data: userData } = await client
    .from("accounts_user")
    .select("is_superuser")
    .eq("id", userId)
    .maybeSingle();

  if (userData?.is_superuser) {
    return; // Universal Super Admin bypass
  }

  // 2. Query effective modules via stored procedure
  const { data: moduleList, error: rpcError } = await client.rpc("get_user_effective_modules", {
    p_user_id: userId,
    p_workspace_id: workspaceId,
  });

  if (rpcError) {
    // Fallback: don't silently grant access if RPC failed
    console.error("Failed to query effective modules:", rpcError);
    throw new HttpError(403, "Access denied: failed to verify module authorization");
  }

  if (!isModuleEnabled(moduleList, moduleKey)) {
    throw new HttpError(403, `Access denied: module '${moduleKey}' is not enabled for your account`);
  }
}

/**
 * get_user_effective_modules() RETURNS JSONB shaped `{ "<module_key>": true|false, ... }`
 * (see migration 20261121134000). An array of `{module_key, enabled}` rows is also accepted so a
 * future RETURNS TABLE variant keeps working. Anything else, or a missing key, denies (fail closed).
 */
export function isModuleEnabled(moduleList: unknown, moduleKey: string): boolean {
  if (Array.isArray(moduleList)) {
    const row = moduleList.find((m) => m && typeof m === "object" && (m as any).module_key === moduleKey);
    return Boolean(row && (row as any).enabled === true);
  }
  if (moduleList && typeof moduleList === "object") {
    return (moduleList as Record<string, unknown>)[moduleKey] === true;
  }
  return false;
}
