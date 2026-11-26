import { NextRequest, NextResponse } from "next/server";
import { errorJson, requireSession, RouteError, withSessionCookies } from "@/lib/serverAuth";
import { functionsBaseUrl } from "@/lib/supabaseServer";

/**
 * Browser -> Supabase Edge Function proxy. Forwards the caller's session JWT from the HTTP-only cookie
 * (so the browser never needs its own Supabase password session, which would skip 2FA). The Edge
 * Function re-checks the JWT, 2FA level, workspace membership and module access itself.
 * The function's JSON envelope ({ success, data | error }) and status are passed through unchanged.
 */
export const dynamic = "force-dynamic";

const ALLOWED = new Set(["test-connection", "shopify-sync", "razorpay-sync", "meta-ads-sync", "instagram-sync", "delhivery-sync"]);

export async function POST(req: NextRequest, { params }: { params: { name: string } }) {
  try {
    if (!ALLOWED.has(params.name)) throw new RouteError(404, "Not found");
    const session = await requireSession(req);
    const functionsUrl = functionsBaseUrl();
    const anonKey = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "").trim();
    if (!functionsUrl || !anonKey) throw new RouteError(503, "Serverless functions URL is not configured");

    const payload = await req.text();
    let upstream: Response;
    try {
      upstream = await fetch(`${functionsUrl}/${params.name}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.accessToken}`, apikey: anonKey },
        body: payload || "{}",
      });
    } catch (err) {
      throw new RouteError(502, `Could not reach ${params.name}: ${(err as Error).message}`);
    }
    const text = await upstream.text();
    const res = new NextResponse(text || JSON.stringify({ success: false, error: `HTTP ${upstream.status}` }), {
      status: upstream.status,
      headers: { "Content-Type": "application/json" },
    });
    return withSessionCookies(res, session);
  } catch (err) {
    return errorJson(err);
  }
}
