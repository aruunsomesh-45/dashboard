import { NextRequest, NextResponse } from "next/server";
import { getPublicAuthClient, getAuthPayloadForUser } from "@/lib/serverlessAuth";
import { getAdminClient } from "@/lib/supabaseServer";

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
    const { data: authData, error: authError } = await authClient.auth.signUp({
      email,
      password,
    });

    if (authError || !authData.user) {
      return NextResponse.json({ error: authError?.message || "Registration failed." }, { status: 400 });
    }

    const admin = getAdminClient();
    const userId = authData.user.id;

    // Check or create workspace
    const slug = workspaceName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "workspace";
    const { data: ws } = await admin
      .from("tenancy_workspace")
      .insert({ name: workspaceName, slug: `${slug}-${Date.now().toString().slice(-4)}` })
      .select()
      .single();

    if (ws) {
      // Add membership
      await admin.from("tenancy_workspacemember").insert({
        workspace_id: ws.id,
        user_id: userId,
        role: "owner",
      });
      // Add brand
      await admin.from("tenancy_brand").insert({
        workspace_id: ws.id,
        name: `${workspaceName} Brand`,
        currency: "INR",
        timezone: "Asia/Kolkata",
      });
    }

    const { user, workspaces } = await getAuthPayloadForUser(authData.user);

    const res = NextResponse.json({
      user,
      workspaces,
      redirect: "/dashboard",
    });

    if (authData.session) {
      const cookieOpts = {
        path: "/",
        httpOnly: true,
        sameSite: "lax" as const,
        secure: process.env.NODE_ENV === "production",
        maxAge: 60 * 60 * 24 * 7,
      };
      res.cookies.set("sb-access-token", authData.session.access_token, cookieOpts);
      res.cookies.set("sb-refresh-token", authData.session.refresh_token, cookieOpts);
      res.cookies.set("sessionid", authData.session.access_token, cookieOpts);
    }

    return res;
  } catch (err: any) {
    console.error("Serverless register error:", err);
    return NextResponse.json({ error: err?.message || "Registration error" }, { status: 500 });
  }
}
