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
    const { data: integrations, error } = await admin
      .from("integrations_integration")
      .select(`
        id,
        workspace_id,
        brand_id,
        provider,
        status,
        account_identifier,
        last_synced_at,
        last_error_message,
        created_at,
        updated_at
      `)
      .order("updated_at", { ascending: false });

    if (error) throw error;

    const { data: workspaces } = await admin
      .from("tenancy_workspace")
      .select("id, name");

    const { data: brands } = await admin
      .from("tenancy_brand")
      .select("id, name");

    const enriched = (integrations || []).map((i) => {
      const ws = (workspaces || []).find((w) => w.id === i.workspace_id);
      const b = (brands || []).find((br) => br.id === i.brand_id);
      return {
        ...i,
        workspace_name: ws?.name || "Unknown Workspace",
        brand_name: b?.name || "Unknown Brand",
      };
    });

    return NextResponse.json({ integrations: enriched });
  } catch (err: any) {
    return NextResponse.json({ error: "Failed to load integrations", details: err?.message }, { status: 500 });
  }
}
