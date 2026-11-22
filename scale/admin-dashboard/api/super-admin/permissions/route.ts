import { NextRequest, NextResponse } from "next/server";
import { getAdminClient, logAdminAudit, verifySuperAdmin } from "@/lib/serverAdmin";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const auth = await verifySuperAdmin(req);
  if (!auth.authorized || !auth.user) {
    return NextResponse.json({ error: auth.error }, { status: auth.status || 401 });
  }

  const admin = getAdminClient();
  const body = await req.json();

  const { targetType, userId, workspaceId, moduleKey, enabled, reason, bulkModules } = body;

  try {
    if (targetType === "user") {
      if (!userId || !workspaceId) {
        return NextResponse.json({ error: "userId and workspaceId are required for user module permissions" }, { status: 400 });
      }

      // Handle bulk update
      if (bulkModules && Array.isArray(bulkModules)) {
        for (const item of bulkModules) {
          const { error: upsertErr } = await admin
            .from("user_module_permissions")
            .upsert(
              {
                user_id: userId,
                workspace_id: workspaceId,
                module_key: item.moduleKey,
                enabled: item.enabled,
                updated_by: auth.user.id,
                updated_at: new Date().toISOString(),
              },
              { onConflict: "user_id,workspace_id,module_key" }
            );
          if (upsertErr) throw upsertErr;
        }

        await logAdminAudit(auth.user.id, "USER_MODULE_PERMISSIONS_BULK_UPDATE", {
          targetUserId: userId,
          targetWorkspaceId: workspaceId,
          metadata: { bulkModules, reason },
          ipAddress: req.headers.get("x-forwarded-for"),
        });

        return NextResponse.json({ success: true, message: "Bulk user module permissions updated successfully" });
      }

      // Single module toggle
      if (!moduleKey) {
        return NextResponse.json({ error: "moduleKey is required" }, { status: 400 });
      }

      const { error: upsertError } = await admin
        .from("user_module_permissions")
        .upsert(
          {
            user_id: userId,
            workspace_id: workspaceId,
            module_key: moduleKey,
            enabled: Boolean(enabled),
            updated_by: auth.user.id,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "user_id,workspace_id,module_key" }
        );

      if (upsertError) throw upsertError;

      await logAdminAudit(auth.user.id, enabled ? "USER_MODULE_ENABLED" : "USER_MODULE_DISABLED", {
        targetUserId: userId,
        targetWorkspaceId: workspaceId,
        metadata: { moduleKey, enabled: Boolean(enabled), reason: reason || "Admin toggle" },
        ipAddress: req.headers.get("x-forwarded-for"),
      });

      return NextResponse.json({
        success: true,
        message: `Module '${moduleKey}' ${enabled ? "enabled" : "disabled"} for user`,
      });
    }

    if (targetType === "workspace") {
      if (!workspaceId || !moduleKey) {
        return NextResponse.json({ error: "workspaceId and moduleKey are required" }, { status: 400 });
      }

      const { error: upsertError } = await admin
        .from("workspace_module_permissions")
        .upsert(
          {
            workspace_id: workspaceId,
            module_key: moduleKey,
            enabled: Boolean(enabled),
            updated_by: auth.user.id,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "workspace_id,module_key" }
        );

      if (upsertError) throw upsertError;

      await logAdminAudit(auth.user.id, enabled ? "WORKSPACE_MODULE_ENABLED" : "WORKSPACE_MODULE_DISABLED", {
        targetWorkspaceId: workspaceId,
        metadata: { moduleKey, enabled: Boolean(enabled), reason: reason || "Admin workspace baseline toggle" },
        ipAddress: req.headers.get("x-forwarded-for"),
      });

      return NextResponse.json({
        success: true,
        message: `Workspace baseline for module '${moduleKey}' set to ${enabled ? "enabled" : "disabled"}`,
      });
    }

    return NextResponse.json({ error: "Invalid targetType. Expected 'user' or 'workspace'" }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ error: "Failed to update module permissions", details: err?.message }, { status: 500 });
  }
}
