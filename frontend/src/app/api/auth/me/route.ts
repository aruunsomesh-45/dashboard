import { NextRequest, NextResponse } from "next/server";
import { getAuthPayloadForUser } from "@/lib/serverlessAuth";
import { errorJson, requireSession, withSessionCookies } from "@/lib/serverAuth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    // requireSession refreshes an expired access token from the refresh cookie (1h access-token lifetime).
    const session = await requireSession(req);
    const payload = await getAuthPayloadForUser(session.authUser);
    return withSessionCookies(NextResponse.json(payload), session);
  } catch (err) {
    return errorJson(err);
  }
}
