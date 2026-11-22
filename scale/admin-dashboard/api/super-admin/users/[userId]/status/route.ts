import { NextRequest, NextResponse } from "next/server";
import { getAdminClient, logAdminAudit, verifySuperAdmin } from "@/lib/serverAdmin";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: { userId: string } }) {
  const auth = await verifySuperAdmin(req);
  if (!auth.authorized || !auth.user) {
    return NextResponse.json({ error: auth.error }, { status: auth.status || 401 });
  }

  const userId = params.userId;
  const admin = getAdminClient();
  const body = await req.json();
  const { isActive, reason } = body;

  if (typeof isActive !== "boolean") {
    return NextResponse.json({ error: "isActive boolean is required" }, { status: 400 });
  }

  // Prevent admin from suspending themselves
  if (auth.user.id === userId && !isActive) {
    return NextResponse.json({ error: "Cannot suspend your own super admin account" }, { status: 400 });
  }

  try {
    const { error: updateError } = await admin
      .from("accounts_user")
      .update({ is_active: isActive, updated_at: new Date().toISOString() })
      .eq("id", userId);

    if (updateError) throw updateError;

    await logAdminAudit(auth.user.id, isActive ? "USER_ACCOUNT_ACTIVATED" : "USER_ACCOUNT_SUSPENDED", {
      targetUserId: userId,
      metadata: { isActive, reason: reason || "Admin status toggle" },
      ipAddress: req.headers.get("x-forwarded-for"),
    });

    return NextResponse.json({
      success: true,
      message: `User account has been ${isActive ? "activated" : "suspended"}`,
    });
  } catch (err: any) {
    return NextResponse.json({ error: "Failed to update user account status", details: err?.message }, { status: 500 });
  }
}
