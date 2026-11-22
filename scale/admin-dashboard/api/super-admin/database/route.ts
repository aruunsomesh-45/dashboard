import { NextRequest, NextResponse } from "next/server";
import { getAdminClient, verifySuperAdmin } from "@/lib/serverAdmin";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await verifySuperAdmin(req);
  if (!auth.authorized) {
    return NextResponse.json({ error: auth.error }, { status: auth.status || 401 });
  }

  const admin = getAdminClient();

  const tables = [
    "accounts_user",
    "tenancy_workspace",
    "tenancy_brand",
    "tenancy_workspacemember",
    "platform_modules",
    "workspace_module_permissions",
    "user_module_permissions",
    "integrations_integration",
    "integrations_syncrun",
    "integrations_webhookevent",
    "commerce_order",
    "commerce_orderline",
    "analytics_dailyfact",
    "admin_audit_logs",
  ];

  try {
    const tableCounts = await Promise.all(
      tables.map(async (tbl) => {
        const { count, error } = await admin.from(tbl).select("*", { count: "exact", head: true });
        return {
          table_name: tbl,
          row_count: error ? 0 : count || 0,
          status: error ? "error" : "online",
        };
      })
    );

    return NextResponse.json({
      database: {
        host: "aws-0-ap-south-1.pooler.supabase.com",
        engine: "PostgreSQL 15.6 (Supabase Cloud)",
        tables: tableCounts,
        rls_enabled: true,
        ssl: true,
      },
    });
  } catch (err: any) {
    return NextResponse.json({ error: "Failed to inspect database", details: err?.message }, { status: 500 });
  }
}
