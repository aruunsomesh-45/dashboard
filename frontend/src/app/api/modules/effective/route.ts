import { NextRequest, NextResponse } from "next/server";
import { getAdminClient } from "@/lib/supabaseServer";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("Authorization") || "";
  const match = authHeader.match(/^Bearer\s+(\S+)$/i);
  if (!match) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const token = match[1];
  const admin = getAdminClient();

  const { data: authData, error: authError } = await admin.auth.getUser(token);
  if (authError || !authData?.user) {
    return NextResponse.json({ error: "Invalid session" }, { status: 401 });
  }

  const userId = authData.user.id;
  const workspaceId = req.nextUrl.searchParams.get("workspace_id");

  try {
    // Check if user is super admin
    const { data: userProfile } = await admin
      .from("accounts_user")
      .select("id, email, is_active, is_superuser")
      .eq("id", userId)
      .single();

    if (!userProfile?.is_active) {
      return NextResponse.json({ error: "Account suspended" }, { status: 403 });
    }

    const isSuperAdmin = Boolean(userProfile?.is_superuser);

    // Call stored procedure to get effective modules
    const { data: effectiveModules, error: rpcError } = await admin.rpc(
      "get_user_effective_modules",
      {
        p_user_id: userId,
        p_workspace_id: workspaceId || "00000000-0000-0000-0000-000000000000",
      }
    );

    let moduleMap: Record<string, boolean> = {
      shopify: true,
      razorpay: true,
      delivery: true,
      meta_ads: true,
      instagram: true,
    };

    if (effectiveModules && typeof effectiveModules === "object") {
      moduleMap = { ...moduleMap, ...effectiveModules };
    }

    return NextResponse.json({
      is_super_admin: isSuperAdmin,
      modules: moduleMap,
    });
  } catch (err: any) {
    return NextResponse.json({ error: "Failed to evaluate module permissions", details: err?.message }, { status: 500 });
  }
}
