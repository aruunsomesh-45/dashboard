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
  const action = searchParams.get("action");
  const limit = parseInt(searchParams.get("limit") || "100", 10);

  try {
    let query = admin
      .from("admin_audit_logs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(limit);

    if (action) {
      query = query.ilike("action", `%${action}%`);
    }

    const { data: logs, error } = await query;
    if (error) throw error;

    return NextResponse.json({ logs: logs || [] });
  } catch (err: any) {
    return NextResponse.json({ error: "Failed to load audit logs", details: err?.message }, { status: 500 });
  }
}
