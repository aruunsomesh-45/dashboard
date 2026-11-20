import { NextRequest, NextResponse } from "next/server";

/**
 * Server-side route guard for dashboard pages.
 *
 * A request for a protected page without a session cookie is redirected to /login before any HTML is sent.
 * The cookie is only checked for presence here; its validity is enforced by Django on every /api call
 * (an expired or forged cookie gets 401 and AuthContext sends the user to /login).
 */
const SESSION_COOKIE = process.env.SESSION_COOKIE_NAME || "sessionid";

const PUBLIC_PATHS = new Set(["/login", "/register", "/forgot-password", "/reset-password", "/mfa-challenge"]);
const PUBLIC_PREFIXES = ["/invites/"];

export function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  if (PUBLIC_PATHS.has(pathname) || PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }
  if (req.cookies.get(SESSION_COOKIE)?.value) {
    return NextResponse.next();
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  const target = pathname + search;
  if (target !== "/" && target !== "/dashboard") url.searchParams.set("next", target);
  return NextResponse.redirect(url);
}

export const config = {
  // Pages only: skip API proxying, Next internals and static files.
  matcher: ["/((?!api/|_next/|favicon\\.ico|.*\\.[A-Za-z0-9]+$).*)"],
};
