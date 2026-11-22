import { NextRequest, NextResponse } from "next/server";
import { getAdminClient, verifySuperAdmin } from "@/lib/serverAdmin";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await verifySuperAdmin(req);
  if (!auth.authorized) {
    return NextResponse.json({ error: auth.error }, { status: auth.status || 401 });
  }

  const admin = getAdminClient();
  const searchParams = req.nextUrl.searchParams;
  const search = searchParams.get("search")?.toLowerCase().trim();
  const status = searchParams.get("status");

  try {
    let query = admin
      .from("accounts_user")
      .select(`
        id,
        email,
        first_name,
        last_name,
        is_active,
        is_staff,
        is_superuser,
        mfa_enabled,
        last_login,
        created_at,
        updated_at
      `)
      .order("created_at", { ascending: false });

    if (status === "active") {
      query = query.eq("is_active", true);
    } else if (status === "suspended") {
      query = query.eq("is_active", false);
    } else if (status === "superadmin") {
      query = query.eq("is_superuser", true);
    }

    if (search) {
      query = query.ilike("email", `%${search}%`);
    }

    const { data: users, error: usersError } = await query;
    if (usersError) throw usersError;

    // Fetch workspaces and memberships
    const { data: members } = await admin
      .from("tenancy_workspacemember")
      .select("user_id, role, workspace:tenancy_workspace(id, name, slug)");

    // Fetch user module permissions overrides
    const { data: userPerms } = await admin
      .from("user_module_permissions")
      .select("user_id, module_key, enabled");

    // Map memberships and perms to users
    const enrichedUsers = (users || []).map((u) => {
      const userMemberships = (members || []).filter((m) => m.user_id === u.id);
      const userOverrides = (userPerms || []).filter((p) => p.user_id === u.id);
      const disabledOverrides = userOverrides.filter((p) => !p.enabled).map((p) => p.module_key);
      const enabledOverrides = userOverrides.filter((p) => p.enabled).map((p) => p.module_key);

      return {
        ...u,
        workspaces: userMemberships.map((m) => ({
          id: (m.workspace as any)?.id,
          name: (m.workspace as any)?.name,
          role: m.role,
        })),
        module_overrides_count: userOverrides.length,
        disabled_modules: disabledOverrides,
        enabled_modules: enabledOverrides,
      };
    });

    return NextResponse.json({ users: enrichedUsers });
  } catch (err: any) {
    return NextResponse.json({ error: "Failed to list users", details: err?.message }, { status: 500 });
  }
}
