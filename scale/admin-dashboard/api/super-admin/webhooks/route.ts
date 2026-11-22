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
  const provider = searchParams.get("provider");

  try {
    let query = admin
      .from("integrations_webhookevent")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(100);

    if (provider) {
      query = query.eq("provider", provider);
    }

    const { data: webhooks, error } = await query;
    if (error) throw error;

    return NextResponse.json({ webhooks: webhooks || [] });
  } catch (err: any) {
    return NextResponse.json({ error: "Failed to load webhooks log", details: err?.message }, { status: 500 });
  }
}
