import { NextRequest, NextResponse } from "next/server";
import { getPublicAuthClient, getAuthPayloadForUser } from "@/lib/serverlessAuth";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const email = (body.email || "").trim().toLowerCase();
    const password = body.password || "";

    if (!email || !password) {
      return NextResponse.json(
        { error: "Email and password are required." },
        { status: 400 }
      );
    }

    const authClient = getPublicAuthClient();
    const { data: authData, error: authError } = await authClient.auth.signInWithPassword({
      email,
      password,
    });

    if (authError || !authData.user || !authData.session) {
      return NextResponse.json(
        { error: authError?.message || "Invalid email or password." },
        { status: 400 }
      );
    }

    const { user, workspaces } = await getAuthPayloadForUser(authData.user);

    const res = NextResponse.json({
      user,
      workspaces,
      redirect: "/dashboard",
    });

    // Set secure auth cookies for both browser requests and SSR
    const cookieOpts = {
      path: "/",
      httpOnly: true,
      sameSite: "lax" as const,
      secure: process.env.NODE_ENV === "production",
      maxAge: 60 * 60 * 24 * 7, // 7 days
    };

    res.cookies.set("sb-access-token", authData.session.access_token, cookieOpts);
    res.cookies.set("sb-refresh-token", authData.session.refresh_token, cookieOpts);
    res.cookies.set("sessionid", authData.session.access_token, cookieOpts);

    return res;
  } catch (err: any) {
    console.error("Serverless login error:", err);
    return NextResponse.json(
      { error: err?.message || "Internal authentication error" },
      { status: 500 }
    );
  }
}
