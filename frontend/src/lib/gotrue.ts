/**
 * Minimal Supabase Auth (GoTrue) REST helpers for calls made AS THE USER (MFA factor enrolment,
 * challenge, verify). Server-only: used by the Next.js API routes.
 */
import { RouteError } from "./routeError";

function authBase(): { url: string; anon: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
  if (!url || !anon) throw new RouteError(503, "Supabase Auth is not configured");
  return { url: url.replace(/\/+$/, ""), anon };
}

export async function gotrue<T = any>(
  path: string,
  opts: { method?: string; token: string; body?: unknown },
): Promise<{ status: number; data: T | null; error: string | null }> {
  const { url, anon } = authBase();
  const res = await fetch(`${url}/auth/v1${path}`, {
    method: opts.method ?? "GET",
    headers: {
      apikey: anon,
      Authorization: `Bearer ${opts.token}`,
      "Content-Type": "application/json",
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const json: any = await res.json().catch(() => null);
  if (!res.ok) {
    return { status: res.status, data: null, error: json?.msg || json?.message || json?.error_description || json?.error || `HTTP ${res.status}` };
  }
  return { status: res.status, data: json as T, error: null };
}

/** Claims of a JWT whose signature has ALREADY been verified (by auth.getUser). Never use on unverified input. */
export function verifiedJwtClaims(token: string): Record<string, any> {
  try {
    const part = token.split(".")[1] || "";
    const json = Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    return {};
  }
}

export interface Factor {
  id: string;
  factor_type: string;
  status: "verified" | "unverified";
  friendly_name?: string;
  created_at?: string;
  updated_at?: string;
}

export function totpFactors(user: { factors?: Factor[] | null } | null | undefined): Factor[] {
  return ((user?.factors as Factor[] | undefined) || []).filter((f) => f.factor_type === "totp");
}

export function hasVerifiedTotp(user: { factors?: Factor[] | null } | null | undefined): boolean {
  return totpFactors(user).some((f) => f.status === "verified");
}

/** challenge + verify a TOTP factor with the user's token. Returns the upgraded (aal2) session. */
export async function verifyTotp(token: string, factorId: string, code: string) {
  const ch = await gotrue<{ id: string }>(`/factors/${factorId}/challenge`, { method: "POST", token, body: {} });
  if (ch.error || !ch.data) throw new RouteError(400, "Could not start the verification challenge");
  const v = await gotrue<{ access_token: string; refresh_token: string }>(`/factors/${factorId}/verify`, {
    method: "POST",
    token,
    body: { challenge_id: ch.data.id, code: String(code).replace(/\s+/g, "") },
  });
  if (v.error || !v.data?.access_token) throw new RouteError(400, "Invalid verification code");
  return v.data;
}
