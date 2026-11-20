/**
 * Redirect safety helpers.
 *
 * `next` / return-to values travel through URLs we do not control (query string,
 * email links), so they must be treated as hostile. Only same-origin relative
 * paths are allowed; anything else collapses to the default landing page.
 */

export const DEFAULT_AFTER_LOGIN = "/dashboard";

/** Pages reachable without a session. Everything else is protected (see src/middleware.ts). */
export const PUBLIC_PATHS = ["/login", "/register", "/forgot-password", "/reset-password", "/mfa-challenge"];
const PUBLIC_PREFIXES = ["/invites/"];

export function isPublicPath(pathname: string): boolean {
  const path = pathname.split("?")[0];
  return PUBLIC_PATHS.includes(path) || PUBLIC_PREFIXES.some((p) => path.startsWith(p));
}

// Routes that must never be a post-login destination (would loop or leak state).
const BLOCKED_PREFIXES = ["/login", "/register", "/forgot-password", "/reset-password", "/mfa-challenge"];

export function safeNextPath(raw: string | null | undefined): string {
  if (!raw) return DEFAULT_AFTER_LOGIN;
  let value = raw.trim();
  try {
    value = decodeURIComponent(value);
  } catch {
    return DEFAULT_AFTER_LOGIN;
  }

  // Must be a single-slash relative path. Rejects "//evil.com", "/\evil.com",
  // "http://...", "javascript:...", and anything with control characters.
  if (!value.startsWith("/")) return DEFAULT_AFTER_LOGIN;
  if (value.startsWith("//") || value.startsWith("/\\")) return DEFAULT_AFTER_LOGIN;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return DEFAULT_AFTER_LOGIN;

  // Final check: resolving against a dummy origin must stay on that origin.
  try {
    const base = "http://local.invalid";
    const url = new URL(value, base);
    if (url.origin !== base) return DEFAULT_AFTER_LOGIN;
    const path = url.pathname + url.search + url.hash;
    if (BLOCKED_PREFIXES.some((p) => url.pathname === p || url.pathname.startsWith(p + "/"))) {
      return DEFAULT_AFTER_LOGIN;
    }
    return path;
  } catch {
    return DEFAULT_AFTER_LOGIN;
  }
}

/** Build `/login?next=...` for a protected path the user was trying to reach. */
export function loginUrlFor(path: string, reason?: "expired"): string {
  const params = new URLSearchParams();
  const next = safeNextPath(path);
  if (next !== DEFAULT_AFTER_LOGIN && next !== "/") params.set("next", next);
  if (reason) params.set("reason", reason);
  const qs = params.toString();
  return qs ? `/login?${qs}` : "/login";
}
