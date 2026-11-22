import { NextRequest, NextResponse } from "next/server";
import { getAdminClient } from "@/lib/supabaseServer";
import { ACCESS_COOKIE, clearSessionCookies } from "@/lib/serverAuth";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  // Revoke the refresh token server-side so a copied cookie cannot be refreshed after logout.
  const token = req.cookies.get(ACCESS_COOKIE)?.value;
  if (token) {
    try {
      await getAdminClient().auth.admin.signOut(token, "local");
    } catch {
      // best effort: cookies are cleared regardless
    }
  }
  const res = NextResponse.json({ message: "Logged out" });
  clearSessionCookies(res);
  return res;
}
