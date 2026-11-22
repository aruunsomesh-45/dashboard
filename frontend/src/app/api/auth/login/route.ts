import { NextRequest, NextResponse } from "next/server";
import { getPublicAuthClient, getAuthPayloadForUser } from "@/lib/serverlessAuth";
import { setSessionCookies } from "@/lib/serverAuth";

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
      // Generic message (do not reveal whether the email exists), except the actionable unconfirmed-email case.
      const unconfirmed = /not confirmed/i.test(authError?.message || "");
      return NextResponse.json(
        { error: unconfirmed ? "Please confirm your email address before signing in." : "Invalid email or password." },
        { status: 400 }
      );
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
    console.error("Serverless login error:", err);
    return NextResponse.json(
      { error: "Internal authentication error" },
      { status: 500 }
    );
  }
}
