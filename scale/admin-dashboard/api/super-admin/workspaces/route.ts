import { NextRequest, NextResponse } from "next/server";
import { getAdminClient, verifySuperAdmin } from "@/lib/serverAdmin";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await verifySuperAdmin(req);
  if (!auth.authorized) {
    return NextResponse.json({ error: auth.error }, { status: auth.status || 401 });
  }

  const admin = getAdminClient();

  try {
    const { data: workspaces, error: wsError } = await admin
      .from("tenancy_workspace")
      .select("id, name, slug, plan, is_active, created_at, updated_at")
      .order("created_at", { ascending: false });

    if (wsError) throw wsError;

    const { data: members } = await admin
      .from("tenancy_workspacemember")
      .select("workspace_id, role, user_id");

    const { data: brands } = await admin
      .from("tenancy_brand")
      .select("id, workspace_id, name, currency");

    const { data: wsPerms } = await admin
      .from("workspace_module_permissions")
      .select("workspace_id, module_key, enabled");

    const enriched = (workspaces || []).map((ws) => {
      const wsMembers = (members || []).filter((m) => m.workspace_id === ws.id);
      const wsBrands = (brands || []).filter((b) => b.workspace_id === ws.id);
      const perms = (wsPerms || []).filter((p) => p.workspace_id === ws.id);

      return {
        ...ws,
        member_count: wsMembers.length,
        brands: wsBrands,
        module_permissions: perms,
      };
    });

    return NextResponse.json({ workspaces: enriched });
  } catch (err: any) {
    return NextResponse.json({ error: "Failed to list workspaces", details: err?.message }, { status: 500 });
  }
}
