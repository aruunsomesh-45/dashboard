import { NextRequest, NextResponse } from "next/server";
import { getPublicAuthClient, getAuthPayloadForUser } from "@/lib/serverlessAuth";
import { getAdminClient } from "@/lib/supabaseServer";
import { setSessionCookies } from "@/lib/serverAuth";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const email = (body.email || "").trim().toLowerCase();
    const password = body.password || "";
    const workspaceName = (body.workspace_name || "").trim() || "My Workspace";

    if (!email || !password) {
      return NextResponse.json({ error: "Email and password are required." }, { status: 400 });
    }

    const authClient = getPublicAuthClient();
    // handle_new_auth_user() (migration 20261112000014) provisions accounts_user and, unless the email has a
    // pending invite, an owner workspace + brand named from `organization_name`.
    const { data: authData, error: authError } = await authClient.auth.signUp({
      email,
      password,
      options: { data: { organization_name: workspaceName } },
    });

    if (authError || !authData.user) {
      return NextResponse.json({ error: authError?.message || "Registration failed." }, { status: 400 });
    }
    // With email confirmation on, an already-registered email comes back as an obfuscated user with no identities.
    if (Array.isArray(authData.user.identities) && authData.user.identities.length === 0) {
      return NextResponse.json({ error: "An account with this email already exists. Please sign in." }, { status: 400 });
    }

    const admin = getAdminClient();
    const userId = authData.user.id;

    // Fallback only for databases where the provisioning trigger is not installed: never create a second workspace.
    const { data: accountRow } = await admin.from("accounts_user").select("id").eq("id", userId).maybeSingle();
    const { count: membershipCount } = await admin
      .from("tenancy_workspacemember")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId);
    if (accountRow && !membershipCount) {
      const slug = workspaceName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 40) || "workspace";
      const { data: ws } = await admin
        .from("tenancy_workspace")
        .insert({ name: workspaceName, slug: `${slug}-${Date.now().toString().slice(-4)}` })
        .select()
        .single();
      if (ws) {
        await admin.from("tenancy_workspacemember").insert({ workspace_id: ws.id, user_id: userId, role: "owner" });
        await admin.from("tenancy_brand").insert({
          workspace_id: ws.id,
          name: `${workspaceName} Brand`,
          currency: "INR",
          timezone: "Asia/Kolkata",
        });
      }
    }

    if (!authData.session) {
      return NextResponse.json({
        confirmation_required: true,
        message: "Account created. Check your email and click the confirmation link, then sign in.",
      });
    }

    const { user, workspaces } = await getAuthPayloadForUser(authData.user);

    const res = NextResponse.json({
      user,
      workspaces,
      redirect: "/dashboard",
    });

    setSessionCookies(res, authData.session);

    return res;
  } catch (err: any) {
    console.error("Serverless register error:", err);
    return NextResponse.json({ error: "Registration error" }, { status: 500 });
  }
}
