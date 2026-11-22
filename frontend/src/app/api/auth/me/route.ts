import { NextRequest, NextResponse } from "next/server";
import { getPublicAuthClient, getAuthPayloadForUser } from "@/lib/serverlessAuth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const authHeader = req.headers.get("authorization") || "";
    const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.substring(7) : null;
    const cookieToken =
      req.cookies.get("sb-access-token")?.value ||
      req.cookies.get("sessionid")?.value;

    const token = bearerToken || cookieToken;

    if (!token) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    const authClient = getPublicAuthClient();
    const { data: { user: authUser }, error: userError } = await authClient.auth.getUser(token);

    if (userError || !authUser) {
      return NextResponse.json({ error: "Session expired or invalid" }, { status: 401 });
    }

    const payload = await getAuthPayloadForUser(authUser);
    return NextResponse.json(payload);
  } catch (err: any) {
    console.error("Serverless auth/me error:", err);
    return NextResponse.json({ error: err?.message || "Authentication error" }, { status: 500 });
  }
}
