import { NextRequest, NextResponse } from "next/server";
import { getAdminClient, verifySuperAdmin } from "@/lib/serverAdmin";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: { userId: string } }) {
  const auth = await verifySuperAdmin(req);
  if (!auth.authorized) {
    return NextResponse.json({ error: auth.error }, { status: auth.status || 401 });
  }

  const userId = params.userId;
  const admin = getAdminClient();

  try {
    // 1. Fetch user base record
    const { data: user, error: userError } = await admin
      .from("accounts_user")
      .select("id, email, first_name, last_name, is_active, is_staff, is_superuser, mfa_enabled, last_login, created_at, updated_at")
      .eq("id", userId)
      .single();

    if (userError || !user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    // 2. Fetch workspaces and brands
    const { data: memberships } = await admin
      .from("tenancy_workspacemember")
      .select("role, created_at, workspace:tenancy_workspace(id, name, slug, plan, is_active, created_at)")
      .eq("user_id", userId);

    const workspaceIds = (memberships || []).map((m: any) => m.workspace?.id).filter(Boolean);

    let brands: any[] = [];
    let integrations: any[] = [];
    let syncRuns: any[] = [];
    let webhooks: any[] = [];

    if (workspaceIds.length > 0) {
      const { data: brandList } = await admin
        .from("tenancy_brand")
        .select("id, workspace_id, name, currency, timezone, created_at")
        .in("workspace_id", workspaceIds);
      brands = brandList || [];

      const { data: integList } = await admin
        .from("integrations_integration")
        .select("id, workspace_id, brand_id, provider, status, account_identifier, last_synced_at, last_error_message, created_at")
        .in("workspace_id", workspaceIds);
      integrations = integList || [];

      const { data: syncList } = await admin
        .from("integrations_syncrun")
        .select("id, workspace_id, brand_id, provider, status, records_processed, error_message, started_at, completed_at")
        .in("workspace_id", workspaceIds)
        .order("started_at", { ascending: false })
        .limit(20);
      syncRuns = syncList || [];

      const brandIds = brands.map((b) => b.id);
      if (brandIds.length > 0) {
        const { data: whList } = await admin
          .from("integrations_webhookevent")
          .select("id, brand_id, provider, topic, event_id, processed, created_at")
          .in("brand_id", brandIds)
          .order("created_at", { ascending: false })
          .limit(20);
        webhooks = whList || [];
      }
    }

    // 3. Fetch all platform modules
    const { data: allModules } = await admin
      .from("platform_modules")
      .select("*")
      .order("created_at", { ascending: true });

    // 4. Fetch workspace permissions for user's primary workspace
    const primaryWorkspaceId = workspaceIds[0] || null;
    let workspacePerms: any[] = [];
    if (primaryWorkspaceId) {
      const { data: wsPerms } = await admin
        .from("workspace_module_permissions")
        .select("*")
        .eq("workspace_id", primaryWorkspaceId);
      workspacePerms = wsPerms || [];
    }

    // 5. Fetch per-user module permissions overrides
    const { data: userPerms } = await admin
      .from("user_module_permissions")
      .select("*")
      .eq("user_id", userId);

    // Build effective modules status
    const modulesWithPermissions = (allModules || []).map((mod) => {
      const wsPerm = workspacePerms.find((p) => p.module_key === mod.module_key);
      const userPerm = (userPerms || []).find((p) => p.module_key === mod.module_key);

      const workspaceBaseline = wsPerm ? wsPerm.enabled : true;
      const userOverride = userPerm !== undefined ? userPerm.enabled : null;
      const effective = user.is_superuser ? true : (userOverride !== null ? userOverride : workspaceBaseline);

      return {
        ...mod,
        workspace_baseline: workspaceBaseline,
        user_override: userOverride,
        effective_enabled: effective,
        last_modified_by: userPerm?.updated_by || wsPerm?.updated_by || null,
        last_modified_at: userPerm?.updated_at || wsPerm?.updated_at || null,
      };
    });

    // 6. Fetch admin audit logs targeting this user
    const { data: auditLogs } = await admin
      .from("admin_audit_logs")
      .select("*")
      .eq("target_user_id", userId)
      .order("created_at", { ascending: false })
      .limit(30);

    return NextResponse.json({
      user,
      workspaces: memberships || [],
      brands,
      modules: modulesWithPermissions,
      integrations,
      sync_runs: syncRuns,
      webhooks,
      audit_logs: auditLogs || [],
    });
  } catch (err: any) {
    return NextResponse.json({ error: "Failed to load user details", details: err?.message }, { status: 500 });
  }
}
