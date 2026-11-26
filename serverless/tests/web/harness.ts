/**
 * Harness for the Next.js API routes (frontend/src/app/api/**), executed under Deno.
 *
 * What is REAL: the route handlers, serverAuth/gotrue/accountRoutes/credentialCrypto/serverlessAuth libs,
 * supabase-js (for GoTrue calls), next/server, the migrated schema + triggers (PGlite), and the Edge
 * Function handlers that sync-now and /api/fn forward to. What is FAKE: the PostgREST transport
 * (pg_supabase double), GoTrue (in-process handler below, incl. TOTP factors with real RFC 6238 codes),
 * and third-party APIs (ScriptedFetch). No request leaves the process: any un-routed outbound fetch throws.
 */
import { World } from "../helpers/world.ts";
import { pgAdminClient, type Identity } from "../helpers/pg_supabase.ts";
import { createHandler as shopifySync } from "../../supabase/functions/shopify-sync/handler.ts";
import { createHandler as razorpaySync } from "../../supabase/functions/razorpay-sync/handler.ts";
import { createHandler as metaSync } from "../../supabase/functions/meta-ads-sync/handler.ts";
import { createHandler as igSync } from "../../supabase/functions/instagram-sync/handler.ts";
import { createHandler as testConn } from "../../supabase/functions/test-connection/handler.ts";
import { createHandler as delhiverySync } from "../../supabase/functions/delhivery-sync/handler.ts";

export const SUPABASE_URL = "http://fake-supabase.test";
export const FUNCTIONS_URL = "http://fake-supabase.test/functions/v1";

// Module-level env is read when the route modules load: set it before they are imported.
Deno.env.set("NEXT_PUBLIC_SUPABASE_URL", SUPABASE_URL);
Deno.env.set("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test-key");
Deno.env.set("NEXT_PUBLIC_FUNCTIONS_URL", FUNCTIONS_URL);
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-test-key");
Deno.env.set("NEXT_PUBLIC_SITE_URL", "https://app.example.test");

const realFetch = globalThis.fetch;

// ─── TOTP (RFC 6238, SHA-1, 30 s, 6 digits) ─────────────────────────────────
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32Decode(s: string): Uint8Array {
  let bits = "";
  for (const c of s.replace(/=+$/, "").toUpperCase()) bits += B32.indexOf(c).toString(2).padStart(5, "0");
  const out = new Uint8Array(Math.floor(bits.length / 8));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  return out;
}
function base32Encode(b: Uint8Array): string {
  let bits = "";
  for (const x of b) bits += x.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, "0"), 2)];
  return out;
}
export async function totp(secret: string, at = Date.now()): Promise<string> {
  const counter = Math.floor(at / 1000 / 30);
  const msg = new Uint8Array(8);
  new DataView(msg.buffer).setBigUint64(0, BigInt(counter));
  const key = await crypto.subtle.importKey("raw", base32Decode(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const o = mac[mac.length - 1] & 0xf;
  const n = ((mac[o] & 0x7f) << 24) | (mac[o + 1] << 16) | (mac[o + 2] << 8) | mac[o + 3];
  return String(n % 1_000_000).padStart(6, "0");
}

interface FakeFactor { id: string; factor_type: "totp"; status: "verified" | "unverified"; friendly_name: string; secret: string; created_at: string; updated_at: string }

const b64url = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export class WebWorld {
  passwords = new Map<string, { id: string; password: string }>();
  refreshTokens = new Map<string, string>(); // refresh token -> user id
  factors = new Map<string, FakeFactor[]>(); // user id -> factors
  challenges = new Map<string, string>(); // challenge id -> factor id
  recoverRequests: { email: string; redirect_to: string | null }[] = [];
  edgeCalls: { fn: string; auth: string | null; body: any }[] = [];
  revoked: string[] = [];

  private constructor(public w: World) {}

  static async create(): Promise<WebWorld> {
    const ww = new WebWorld(await World.create());
    ww.install();
    return ww;
  }

  emailOf(userId: string): string {
    return [...this.passwords.entries()].find(([, v]) => v.id === userId)?.[0] ?? "";
  }

  publicFactors(userId: string) {
    return (this.factors.get(userId) ?? []).map(({ secret: _s, ...f }) => f);
  }

  authUser(ident: Identity) {
    return {
      id: ident.id,
      email: ident.email,
      aud: "authenticated",
      role: "authenticated",
      created_at: new Date().toISOString(),
      identities: [{ id: ident.id }],
      factors: this.publicFactors(ident.id),
    };
  }

  /** Mints a JWT-shaped access token carrying aal/amr (signature is never checked: getUser is the oracle). */
  mintSession(userId: string, aal: "aal1" | "aal2" = "aal1", amr: string[] = ["password"]) {
    const email = this.emailOf(userId);
    const access = `h.${b64url({ sub: userId, aal, amr: amr.map((method) => ({ method })), jti: crypto.randomUUID() })}.sig`;
    const refresh = `rt_${crypto.randomUUID()}`;
    this.w.auth.tokens.set(access, { id: userId, email });
    this.refreshTokens.set(refresh, userId);
    return {
      access_token: access,
      refresh_token: refresh,
      token_type: "bearer",
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: this.authUser({ id: userId, email }),
    };
  }

  private revokeUser(userId: string) {
    for (const [t, ident] of this.w.auth.tokens) if (ident?.id === userId) this.w.auth.tokens.set(t, null);
    for (const [r, uid] of this.refreshTokens) if (uid === userId) this.refreshTokens.delete(r);
  }

  /** Service-role double + the auth surface the routes use. */
  private install() {
    const w = this.w;
    // deno-lint-ignore no-explicit-any
    (globalThis as any).__webAdmin = {
      ...pgAdminClient(w.db),
      auth: {
        getUser: (jwt: string) => {
          const ident = w.auth.tokens.get(jwt);
          return Promise.resolve(
            ident ? { data: { user: this.authUser(ident) }, error: null } : { data: { user: null }, error: { message: "invalid JWT: token is expired" } },
          );
        },
        admin: {
          signOut: (jwt: string, scope = "global") => {
            this.revoked.push(jwt);
            const ident = w.auth.tokens.get(jwt);
            if (scope === "global" && ident) this.revokeUser(ident.id);
            else w.auth.tokens.set(jwt, null);
            return Promise.resolve({ data: null, error: null });
          },
          updateUserById: (id: string, attrs: { password?: string }) => {
            const email = this.emailOf(id);
            if (!email) return Promise.resolve({ data: { user: null }, error: { message: "User not found" } });
            if (attrs.password) this.passwords.set(email, { id, password: attrs.password });
            return Promise.resolve({ data: { user: { id, email } }, error: null });
          },
          mfa: {
            deleteFactor: ({ id, userId }: { id: string; userId: string }) => {
              const list = this.factors.get(userId) ?? [];
              if (!list.some((f) => f.id === id)) return Promise.resolve({ data: null, error: { message: "Factor not found" } });
              this.factors.set(userId, list.filter((f) => f.id !== id));
              return Promise.resolve({ data: { id }, error: null });
            },
          },
        },
      },
    };
    globalThis.fetch = this.fetch;
  }

  private json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }

  private bearerUser(req: Request): Identity | null {
    const tok = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    return this.w.auth.tokens.get(tok) ?? null;
  }

  private tokenAal(req: Request): string {
    const tok = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    try {
      return JSON.parse(atob(tok.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).aal;
    } catch {
      return "aal1";
    }
  }

  /** Global fetch: fake GoTrue + Edge Functions gateway; everything else is refused. */
  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url);
    if (url.origin !== SUPABASE_URL) throw new Error(`harness: refused outbound request to ${url.host}`);
    const p = url.pathname;

    if (p.startsWith("/functions/v1/")) {
      const fn = p.split("/").pop()!;
      const body = await req.clone().json().catch(() => null);
      this.edgeCalls.push({ fn, auth: req.headers.get("Authorization"), body });
      const make = { "shopify-sync": shopifySync, "razorpay-sync": razorpaySync, "meta-ads-sync": metaSync, "instagram-sync": igSync, "test-connection": testConn, "delhivery-sync": delhiverySync }[fn];
      if (!make) return this.json({ success: false, error: "function not found" }, 404);
      // The Edge Function's own user client sees GoTrue's view of the token (incl. factors).
      const deps = this.w.deps();
      const userClient = deps.userClient;
      deps.userClient = (r: Request) => {
        const c = userClient(r);
        const ident = this.bearerUser(r);
        c.auth.getUser = () => Promise.resolve(ident ? { data: { user: this.authUser(ident) }, error: null } : { data: { user: null }, error: { message: "invalid JWT" } });
        return c;
      };
      return await make(deps)(req);
    }

    if (p === "/auth/v1/token") {
      const body = await req.json();
      const grant = url.searchParams.get("grant_type");
      if (grant === "password") {
        const rec = this.passwords.get(String(body.email).toLowerCase());
        if (!rec || rec.password !== body.password) {
          return this.json({ error: "invalid_grant", error_description: "Invalid login credentials", code: "invalid_credentials" }, 400);
        }
        return this.json(this.mintSession(rec.id, "aal1", ["password"]));
      }
      if (grant === "refresh_token") {
        const userId = this.refreshTokens.get(body.refresh_token);
        if (!userId) return this.json({ error: "invalid_grant", error_description: "Invalid Refresh Token", code: "refresh_token_not_found" }, 400);
        this.refreshTokens.delete(body.refresh_token); // rotation
        return this.json(this.mintSession(userId));
      }
    }

    if (p === "/auth/v1/signup") {
      const body = await req.json();
      const email = String(body.email).toLowerCase();
      if (this.passwords.has(email)) {
        return this.json({ id: crypto.randomUUID(), email, aud: "authenticated", role: "", identities: [], created_at: new Date().toISOString() });
      }
      const id = crypto.randomUUID();
      await this.w.db.query(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ($1, $2, $3)`, [id, email, JSON.stringify(body.data ?? {})]);
      this.passwords.set(email, { id, password: body.password });
      return this.json(this.mintSession(id));
    }

    if (p === "/auth/v1/recover") {
      const body = await req.json();
      this.recoverRequests.push({ email: String(body.email), redirect_to: url.searchParams.get("redirect_to") });
      return this.json({});
    }

    // MFA factor API (as the user)
    if (p === "/auth/v1/factors" && req.method === "POST") {
      const ident = this.bearerUser(req);
      if (!ident) return this.json({ msg: "invalid JWT" }, 401);
      const list = this.factors.get(ident.id) ?? [];
      if (list.some((f) => f.status === "verified") && this.tokenAal(req) !== "aal2") return this.json({ msg: "AAL2 required" }, 403);
      const secret = base32Encode(crypto.getRandomValues(new Uint8Array(20)));
      const now = new Date().toISOString();
      const f: FakeFactor = { id: crypto.randomUUID(), factor_type: "totp", status: "unverified", friendly_name: "x", secret, created_at: now, updated_at: now };
      this.factors.set(ident.id, [...list, f]);
      const uri = `otpauth://totp/125%20East:${encodeURIComponent(ident.email)}?secret=${secret}&issuer=125%20East`;
      return this.json({ id: f.id, type: "totp", totp: { qr_code: "data:image/svg+xml;utf-8,<svg/>", secret, uri } });
    }
    const m = /^\/auth\/v1\/factors\/([^/]+)\/(challenge|verify)$/.exec(p);
    if (m && req.method === "POST") {
      const ident = this.bearerUser(req);
      if (!ident) return this.json({ msg: "invalid JWT" }, 401);
      const factor = (this.factors.get(ident.id) ?? []).find((f) => f.id === m[1]);
      if (!factor) return this.json({ msg: "Factor not found" }, 404);
      if (m[2] === "challenge") {
        const id = crypto.randomUUID();
        this.challenges.set(id, factor.id);
        return this.json({ id, type: "totp", expires_at: Math.floor(Date.now() / 1000) + 300 });
      }
      const body = await req.json();
      if (this.challenges.get(body.challenge_id) !== factor.id) return this.json({ msg: "Challenge not found" }, 404);
      this.challenges.delete(body.challenge_id);
      if (String(body.code) !== (await totp(factor.secret))) return this.json({ msg: "Invalid TOTP code entered", code: "mfa_verification_failed" }, 422);
      factor.status = "verified";
      factor.updated_at = new Date().toISOString();
      return this.json(this.mintSession(ident.id, "aal2", ["totp", "password"]));
    }

    return this.json({ error: `harness: no fake for ${req.method} ${p}` }, 501);
  };

  /** Simulates the user clicking the emailed recovery link: GoTrue issues a recovery (amr=recovery) session. */
  recoveryLinkSession(email: string) {
    const rec = this.passwords.get(email);
    if (!rec) throw new Error("no such user");
    return this.mintSession(rec.id, "aal1", ["recovery"]);
  }

  /** Creates a tenant through the real provisioning trigger and gives it a password login. */
  async tenant(email: string, org: string, password = "correct horse battery staple") {
    const t = await this.w.signUp(email, org);
    this.passwords.set(email, { id: t.user.id, password });
    const slug = (await this.w.rows<{ slug: string }>(`SELECT slug FROM public.tenancy_workspace WHERE id = $1`, [t.workspace_id]))[0].slug;
    const refresh = `rt_${crypto.randomUUID()}`;
    this.refreshTokens.set(refresh, t.user.id);
    return { ...t, slug, refresh, password };
  }

  restore() {
    globalThis.fetch = realFetch;
  }
}

export interface RouteCall {
  method?: string;
  cookies?: Record<string, string>;
  bearer?: string;
  body?: unknown;
}

// deno-lint-ignore no-explicit-any
type RouteModule = Record<string, (req: any, ctx?: any) => Promise<Response>>;

/** Invokes an App Router handler the way Next does: NextRequest + { params }. */
export async function hit(mod: RouteModule, path: string, o: RouteCall = {}, params?: Record<string, unknown>) {
  const { NextRequest } = await import("next/server");
  const method = o.method ?? "GET";
  const headers = new Headers();
  if (o.cookies) headers.set("cookie", Object.entries(o.cookies).map(([k, v]) => `${k}=${v}`).join("; "));
  if (o.bearer) headers.set("authorization", `Bearer ${o.bearer}`);
  let body: string | undefined;
  if (o.body !== undefined) {
    body = JSON.stringify(o.body);
    headers.set("content-type", "application/json");
  }
  const req = new NextRequest(new URL(path, "http://localhost:3000"), { method, headers, body });
  const res = await mod[method](req, { params: params ?? { path: new URL(path, "http://x").pathname.replace(/^\/api\//, "").split("/").filter(Boolean) } });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  const setCookies = res.headers.getSetCookie?.() ?? [];
  return { status: res.status, body: json, setCookies };
}

export function cookieValue(setCookies: string[], name: string): string | null {
  for (const c of setCookies) {
    const [pair] = c.split(";");
    const i = pair.indexOf("=");
    if (pair.slice(0, i).trim() === name) {
      const v = decodeURIComponent(pair.slice(i + 1));
      return v === "" ? null : v;
    }
  }
  return null;
}

/** Cookie jar: applies Set-Cookie (incl. deletions) to a cookie map, like a browser. */
export function applyCookies(jar: Record<string, string>, setCookies: string[]) {
  for (const c of setCookies) {
    const [pair, ...attrs] = c.split(";");
    const i = pair.indexOf("=");
    const name = pair.slice(0, i).trim();
    const value = decodeURIComponent(pair.slice(i + 1));
    const expired = attrs.some((a) => /max-age=0\b/i.test(a.trim()) || /expires=thu, 01 jan 1970/i.test(a.trim()));
    if (expired || value === "") delete jar[name];
    else jar[name] = value;
  }
  return jar;
}
