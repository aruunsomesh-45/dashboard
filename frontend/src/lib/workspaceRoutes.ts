import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getAdminClient } from "./supabaseServer";
import {
  ADMIN_ROLES,
  errorJson,
  RouteError,
  requireSession,
  requireTenant,
  type Role,
  type SessionContext,
  withSessionCookies,
} from "./serverAuth";

/**
 * Workspace management: create a workspace, rename or delete one, create a brand, and change or remove
 * members. Every rule lives here so the API and the tests share one definition.
 *
 * Rules (enforced server-side; the UI only mirrors them):
 *  - Any signed-in user may create a workspace (up to MAX_OWNED_WORKSPACES they own).
 *  - Rename: owner or admin. Brand creation: owner or admin, within the plan's max_brands.
 *  - Delete workspace: owner only, and the request must repeat the workspace slug as confirmation.
 *  - Role changes: owners may set any role. Admins may only move analysts and viewers between those two roles.
 *  - Removing a member: owners remove anyone; admins remove analysts and viewers only.
 *    Any member may remove themselves (leave the workspace).
 *  - A workspace always keeps at least one owner.
 */

export const WORKSPACE_ROLES: Role[] = ["owner", "admin", "analyst", "viewer"];
export const MAX_OWNED_WORKSPACES = 5;
const NAME_MIN = 2;
const NAME_MAX = 120;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Admin = SupabaseClient;

async function body(req: NextRequest): Promise<Record<string, any>> {
  const b = await req.json().catch(() => null);
  return b && typeof b === "object" && !Array.isArray(b) ? b : {};
}

/** A display name: whitespace collapsed, 2-120 characters. */
export function cleanName(value: unknown, label: string): string {
  const s = String(value ?? "").replace(/\s+/g, " ").trim();
  if (s.length < NAME_MIN || s.length > NAME_MAX) {
    throw new RouteError(400, `${label} must be ${NAME_MIN}-${NAME_MAX} characters`);
  }
  return s;
}

/** URL-safe base for a workspace slug (the slug column holds 50 characters; leave room for a suffix). */
export function slugBase(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return (base || "workspace").slice(0, 40);
}

async function uniqueSlug(admin: Admin, name: string): Promise<string> {
  const base = slugBase(name);
  let slug = base;
  for (let n = 1; ; n++) {
    const { data } = await admin.from("tenancy_workspace").select("id").eq("slug", slug).maybeSingle();
    if (!data) return slug;
    slug = `${base}-${n}`;
  }
}

async function audit(admin: Admin, workspaceId: string, actorId: string, action: string, target: string, metadata: Record<string, unknown>) {
  const { error } = await admin.from("tenancy_auditlog").insert({ workspace_id: workspaceId, actor_id: actorId, action, target, metadata });
  if (error) throw new Error(`audit log write failed: ${error.message}`);
}

async function ownerCount(admin: Admin, workspaceId: string): Promise<number> {
  const { count, error } = await admin
    .from("tenancy_workspacemember")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .eq("role", "owner");
  if (error) throw new Error(error.message);
  return count ?? 0;
}

async function membership(admin: Admin, workspaceId: string, userId: string): Promise<{ role: Role } | null> {
  const { data, error } = await admin
    .from("tenancy_workspacemember")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as { role: Role } | null) ?? null;
}

function requireUuid(value: string, label: string) {
  if (!UUID_RE.test(value)) throw new RouteError(404, `${label} not found`);
}

/** Creates a workspace owned by the caller, provisioned the same way as a self-service signup. */
export async function createWorkspace(admin: Admin, session: SessionContext, req: NextRequest) {
  const b = await body(req);
  const name = cleanName(b.name, "Workspace name");

  const { count: ownedCount, error: ownErr } = await admin
    .from("tenancy_workspacemember")
    .select("id", { count: "exact", head: true })
    .eq("user_id", session.userId)
    .eq("role", "owner");
  if (ownErr) throw new Error(ownErr.message);
  if ((ownedCount ?? 0) >= MAX_OWNED_WORKSPACES) {
    throw new RouteError(409, `You can own at most ${MAX_OWNED_WORKSPACES} workspaces`);
  }

  const slug = await uniqueSlug(admin, name);
  const { data: ws, error: wsErr } = await admin
    .from("tenancy_workspace")
    .insert({ name, slug, plan: "starter", is_active: true })
    .select("id")
    .single();
  if (wsErr || !ws) throw new Error(`workspace insert failed: ${wsErr?.message ?? "no row"}`);
  const workspaceId = ws.id as string;

  try {
    const { error: mErr } = await admin.from("tenancy_workspacemember").insert({ workspace_id: workspaceId, user_id: session.userId, role: "owner" });
    if (mErr) throw new Error(mErr.message);
    const { error: bErr } = await admin.from("tenancy_brand").insert({ workspace_id: workspaceId, name, timezone: "Asia/Kolkata", currency: "INR" });
    if (bErr) throw new Error(bErr.message);
    const { error: sErr } = await admin.from("billing_subscription").insert({
      workspace_id: workspaceId,
      plan: "starter",
      status: "active",
      max_brands: 1,
      max_members: 3,
      history_days_limit: 30,
      current_period_end: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    });
    if (sErr) throw new Error(sErr.message);
    await audit(admin, workspaceId, session.userId, "workspace_created", slug, { name });
  } catch (err) {
    // Roll back: deleting the workspace cascades to whatever was written before the failure.
    await admin.from("tenancy_workspace").delete().eq("id", workspaceId);
    throw err;
  }
  return { id: workspaceId, slug, name };
}

export async function renameWorkspace(admin: Admin, session: SessionContext, slug: string, req: NextRequest) {
  const tenant = await requireTenant(admin, session, slug, null, ADMIN_ROLES);
  const name = cleanName((await body(req)).name, "Workspace name");
  const { error } = await admin.from("tenancy_workspace").update({ name, updated_at: new Date().toISOString() }).eq("id", tenant.workspaceId);
  if (error) throw new Error(error.message);
  await audit(admin, tenant.workspaceId, session.userId, "workspace_renamed", slug, { name });
  return { slug, name };
}

/** Owner only. Irreversible: removes the workspace with its brands, members, orders and history. */
export async function deleteWorkspace(admin: Admin, session: SessionContext, slug: string, req: NextRequest) {
  const tenant = await requireTenant(admin, session, slug, null, ["owner"]);
  const confirm = String((await body(req)).confirm ?? "").trim();
  if (confirm !== slug) throw new RouteError(400, "Type the workspace slug exactly to confirm deletion");
  const { error } = await admin.from("tenancy_workspace").delete().eq("id", tenant.workspaceId);
  if (error) throw new Error(error.message);
  return { deleted: true, slug };
}

export async function changeMemberRole(admin: Admin, session: SessionContext, slug: string, userId: string, req: NextRequest) {
  requireUuid(userId, "Member");
  const tenant = await requireTenant(admin, session, slug, null, ADMIN_ROLES);
  const role = String((await body(req)).role ?? "");
  if (!WORKSPACE_ROLES.includes(role as Role)) throw new RouteError(400, "Invalid role");

  const target = await membership(admin, tenant.workspaceId, userId);
  if (!target) throw new RouteError(404, "Member not found");
  if (target.role === role) return { user_id: userId, role };

  if (tenant.role === "admin") {
    const limited = (r: string) => r === "owner" || r === "admin";
    if (limited(target.role) || limited(role)) throw new RouteError(403, "Only an owner can change owner or admin roles");
  }
  if (target.role === "owner" && (await ownerCount(admin, tenant.workspaceId)) <= 1) {
    throw new RouteError(409, "A workspace must keep at least one owner");
  }

  const { error } = await admin
    .from("tenancy_workspacemember")
    .update({ role })
    .eq("workspace_id", tenant.workspaceId)
    .eq("user_id", userId);
  if (error) throw new Error(error.message);
  await audit(admin, tenant.workspaceId, session.userId, "member_role_changed", userId, { from: target.role, to: role });
  return { user_id: userId, role };
}

export async function removeMember(admin: Admin, session: SessionContext, slug: string, userId: string) {
  requireUuid(userId, "Member");
  const self = userId === session.userId;
  // Anyone may leave; removing someone else needs owner or admin.
  const tenant = await requireTenant(admin, session, slug, null, self ? WORKSPACE_ROLES : ADMIN_ROLES);

  const target = await membership(admin, tenant.workspaceId, userId);
  if (!target) throw new RouteError(404, "Member not found");
  if (!self && tenant.role === "admin" && (target.role === "owner" || target.role === "admin")) {
    throw new RouteError(403, "Only an owner can remove an owner or admin");
  }
  if (target.role === "owner" && (await ownerCount(admin, tenant.workspaceId)) <= 1) {
    throw new RouteError(409, "A workspace must keep at least one owner");
  }

  const { data: brands } = await admin.from("tenancy_brand").select("id").eq("workspace_id", tenant.workspaceId);
  const brandIds = (brands ?? []).map((b: { id: string }) => b.id);
  if (brandIds.length) {
    const { error: bmErr } = await admin.from("tenancy_brandmember").delete().in("brand_id", brandIds).eq("user_id", userId);
    if (bmErr) throw new Error(bmErr.message);
  }
  const { error: pErr } = await admin.from("user_module_permissions").delete().eq("workspace_id", tenant.workspaceId).eq("user_id", userId);
  if (pErr) throw new Error(pErr.message);
  const { error } = await admin.from("tenancy_workspacemember").delete().eq("workspace_id", tenant.workspaceId).eq("user_id", userId);
  if (error) throw new Error(error.message);
  await audit(admin, tenant.workspaceId, session.userId, self ? "member_left" : "member_removed", userId, { role: target.role });
  return { removed: true, self };
}

export async function createBrand(admin: Admin, session: SessionContext, slug: string, req: NextRequest) {
  const tenant = await requireTenant(admin, session, slug, null, ADMIN_ROLES);
  const b = await body(req);
  const name = cleanName(b.name, "Brand name");
  const currency = String(b.currency ?? "INR").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new RouteError(400, "Currency must be a 3-letter code, e.g. INR");
  const timezone = String(b.timezone ?? "Asia/Kolkata").trim();
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    throw new RouteError(400, "Unknown timezone");
  }

  const { data: sub } = await admin.from("billing_subscription").select("max_brands, plan").eq("workspace_id", tenant.workspaceId).maybeSingle();
  const maxBrands = Number(sub?.max_brands ?? 1);
  const { count } = await admin.from("tenancy_brand").select("id", { count: "exact", head: true }).eq("workspace_id", tenant.workspaceId);
  if ((count ?? 0) >= maxBrands) {
    throw new RouteError(409, `Your ${sub?.plan ?? "starter"} plan allows ${maxBrands} brand${maxBrands === 1 ? "" : "s"}`);
  }

  const { data, error } = await admin
    .from("tenancy_brand")
    .insert({ workspace_id: tenant.workspaceId, name, currency, timezone })
    .select("id, name, currency, timezone")
    .single();
  if (error) {
    if ((error as { code?: string }).code === "23505") throw new RouteError(409, "A brand with this name already exists");
    throw new Error(error.message);
  }
  await audit(admin, tenant.workspaceId, session.userId, "brand_created", data.id as string, { name });
  return data;
}

/**
 * Entry point for the workspace-management routes. Returns null when the path is not one of them, so the
 * existing router continues. Paths:
 *   POST   /workspaces                      create a workspace
 *   PATCH  /w/:slug                         rename
 *   DELETE /w/:slug                         delete (owner, slug confirmation)
 *   POST   /w/:slug/brands                  create a brand
 *   PATCH  /w/:slug/members/:userId         change role
 *   DELETE /w/:slug/members/:userId         remove member / leave
 */
export async function handleWorkspaceRoute(req: NextRequest, pathParts: string[], method: string): Promise<NextResponse | null> {
  const isCreate = pathParts.length === 1 && pathParts[0] === "workspaces" && method === "POST";
  const isWs = pathParts[0] === "w" && pathParts.length >= 2;
  const isOurs =
    isCreate ||
    (isWs && pathParts.length === 2 && (method === "PATCH" || method === "DELETE")) ||
    (isWs && pathParts.length === 3 && pathParts[2] === "brands" && method === "POST") ||
    (isWs && pathParts.length === 4 && pathParts[2] === "members" && (method === "PATCH" || method === "DELETE"));
  if (!isOurs) return null;

  try {
    const admin = getAdminClient();
    const session = await requireSession(req, admin);
    const json = (payload: unknown, status = 200) => withSessionCookies(NextResponse.json(payload, { status }), session);

    if (isCreate) return json(await createWorkspace(admin, session, req), 201);
    const slug = pathParts[1];
    if (pathParts.length === 2 && method === "PATCH") return json(await renameWorkspace(admin, session, slug, req));
    if (pathParts.length === 2 && method === "DELETE") return json(await deleteWorkspace(admin, session, slug, req));
    if (pathParts[2] === "brands") return json(await createBrand(admin, session, slug, req), 201);
    if (method === "PATCH") return json(await changeMemberRole(admin, session, slug, pathParts[3], req));
    return json(await removeMember(admin, session, slug, pathParts[3]));
  } catch (err) {
    return errorJson(err);
  }
}

