import { NextRequest, NextResponse } from "next/server";
import { getAdminClient, logAdminAudit, verifySuperAdmin } from "@/lib/serverAdmin";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await verifySuperAdmin(req);
  if (!auth.authorized) {
    return NextResponse.json({ error: auth.error }, { status: auth.status || 401 });
  }

  const admin = getAdminClient();

  try {
    const { data: modules, error } = await admin
      .from("platform_modules")
      .select("*")
      .order("created_at", { ascending: true });

    if (error) throw error;

    // Get usage statistics per module
    const { data: userPerms } = await admin
      .from("user_module_permissions")
      .select("module_key, enabled");

    const enriched = (modules || []).map((m) => {
      const perms = (userPerms || []).filter((p) => p.module_key === m.module_key);
      const disabledCount = perms.filter((p) => !p.enabled).length;
      return {
        ...m,
        users_explicitly_disabled: disabledCount,
        users_explicitly_enabled: perms.filter((p) => p.enabled).length,
      };
    });

    return NextResponse.json({ modules: enriched });
  } catch (err: any) {
    return NextResponse.json({ error: "Failed to load modules", details: err?.message }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  const auth = await verifySuperAdmin(req);
  if (!auth.authorized || !auth.user) {
    return NextResponse.json({ error: auth.error }, { status: auth.status || 401 });
  }

  const admin = getAdminClient();
  const body = await req.json();
  const { moduleKey, isActive } = body;

  if (!moduleKey || typeof isActive !== "boolean") {
    return NextResponse.json({ error: "moduleKey and isActive are required" }, { status: 400 });
  }

  try {
    const { error } = await admin
      .from("platform_modules")
      .update({ is_active: isActive })
      .eq("module_key", moduleKey);

    if (error) throw error;

    await logAdminAudit(auth.user.id, isActive ? "PLATFORM_MODULE_ACTIVATED" : "PLATFORM_MODULE_DEACTIVATED", {
      metadata: { moduleKey, isActive },
      ipAddress: req.headers.get("x-forwarded-for"),
    });

    return NextResponse.json({ success: true, message: `Module '${moduleKey}' global status updated` });
  } catch (err: any) {
    return NextResponse.json({ error: "Failed to update module status", details: err?.message }, { status: 500 });
  }
}
