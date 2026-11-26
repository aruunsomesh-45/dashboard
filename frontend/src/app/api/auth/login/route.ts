import { NextRequest, NextResponse } from "next/server";
import { getPublicAuthClient, getAuthPayloadForUser } from "@/lib/serverlessAuth";
import { setMfaPendingCookies, setSessionCookies } from "@/lib/serverAuth";
import { hasVerifiedTotp } from "@/lib/gotrue";

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

    // 2FA users get only a short-lived pending cookie: the session is issued after /api/v1/auth/mfa/verify.
    if (hasVerifiedTotp(authData.user as any)) {
      const res = NextResponse.json({ mfa_required: true });
      setMfaPendingCookies(res, authData.session);
      return res;
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
    // A missing server secret is a deployment problem, not a user problem: say so (without the value)
    // so it is visible in the network tab and the Vercel function log.
    if (/SUPABASE_SERVICE_ROLE_KEY is not configured/.test(err?.message || "")) {
      return NextResponse.json(
        { error: "Authentication service is misconfigured.", code: "server_misconfigured_service_role_key" },
        { status: 503 }
      );
    }
    return NextResponse.json(
      { error: "Internal authentication error", code: "login_internal_error" },
      { status: 500 }
    );
  }
}
