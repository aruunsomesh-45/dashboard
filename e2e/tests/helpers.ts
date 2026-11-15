import { test as base, expect, Page } from "@playwright/test";
import crypto from "crypto";
import fs from "fs";
import path from "path";

export { expect };

const ROOT = path.join(__dirname, "..");
export const fx = JSON.parse(fs.readFileSync(path.join(ROOT, "fixtures.json"), "utf8"));
export type Who = "owner" | "admin" | "viewer" | "outsider";

// Supabase project ref comes from frontend/.env.local (no hard-coded fallback in source any more).
const envSrc = fs.readFileSync(path.join(ROOT, "..", "frontend", ".env.local"), "utf8");
const SB_REF = (envSrc.match(/NEXT_PUBLIC_SUPABASE_URL=https:\/\/([a-z0-9]+)\.supabase\.co/) || [])[1] || "unknown";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "*",
  "access-control-expose-headers": "*",
};

function b64(o: object) {
  return Buffer.from(JSON.stringify(o)).toString("base64url");
}
// Tokens are REALLY signed (HS256) with the same secret the e2e backend verifies against
// (SUPABASE_JWT_SECRET), so the e2e exercises the real auth path instead of a placeholder "sig".
export const E2E_JWT_SECRET = process.env.E2E_JWT_SECRET || "e2e-only-jwt-secret-0123456789-abcdefghijklmnop";
function fakeJwt(sub: string, email: string) {
  const exp = Math.floor(Date.now() / 1000) + 24 * 3600;
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ sub, email, role: "authenticated", aud: "authenticated", exp });
  const sig = crypto.createHmac("sha256", E2E_JWT_SECRET).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}
function sessionFor(who: Who) {
  const u = fx.users[who];
  const now = Math.floor(Date.now() / 1000);
  return {
    access_token: fakeJwt(u.id, u.email),
    token_type: "bearer",
    expires_in: 86400,
    expires_at: now + 86400,
    refresh_token: "e2e-refresh",
    user: {
      id: u.id, aud: "authenticated", role: "authenticated", email: u.email,
      app_metadata: { provider: "email" }, user_metadata: {}, created_at: "2026-01-01T00:00:00Z",
    },
  };
}

export interface SbOpts {
  authed?: Who | false; // pre-seed a Supabase session for this user
  otpStatus?: number; // status for POST /auth/v1/otp
  verifyFail?: boolean; // fail OTP verification
  verifyAs?: Who;
  memberRole?: string; // role returned for the workspace membership
  noWorkspaces?: boolean;
  tablesFail?: boolean; // make REST table reads return 500
}

/** Mock every call to *.supabase.co. Returns request log so tests can assert on it. */
export async function mockSupabase(page: Page, opts: SbOpts = {}) {
  const log: string[] = [];
  const bodies: Record<string, any[]> = {};
  const who: Who = opts.authed || opts.verifyAs || "owner";
  const u = fx.users[who];
  const role = opts.memberRole || (who === "owner" ? "owner" : who);

  if (opts.authed) {
    const s = sessionFor(opts.authed);
    await page.addInitScript(
      ([k, v]) => localStorage.setItem(k as string, v as string),
      [`sb-${SB_REF}-auth-token`, JSON.stringify(s)]
    );
  }

  await page.route(/supabase\.co/, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    log.push(`${req.method()} ${p}`);
    try { (bodies[p] ||= []).push(req.postDataJSON()); } catch { /* no body */ }
    const json = (b: any, status = 200) =>
      route.fulfill({ status, contentType: "application/json", headers: CORS, body: JSON.stringify(b) });
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });

    if (p.endsWith("/auth/v1/user")) return json(sessionFor(who).user);
    if (p.endsWith("/auth/v1/token")) return json(sessionFor(who));
    if (p.endsWith("/auth/v1/logout")) return route.fulfill({ status: 204, headers: CORS });
    if (p.endsWith("/auth/v1/otp"))
      return opts.otpStatus && opts.otpStatus >= 400
        ? json({ code: opts.otpStatus, error_code: "over_email_send_rate_limit", msg: "Email rate limit exceeded" }, opts.otpStatus)
        : json({});
    if (p.endsWith("/auth/v1/verify"))
      return opts.verifyFail
        ? json({ code: 403, error_code: "otp_expired", msg: "Token has expired or is invalid" }, 403)
        : json(sessionFor(who));
    if (p.endsWith("/auth/v1/authorize"))
      return route.fulfill({ status: 200, contentType: "text/html", headers: CORS, body: "<html><body>E2E-OAUTH-STUB</body></html>" });

    if (p.includes("/rest/v1/")) {
      if (opts.tablesFail) return json({ message: "boom" }, 500);
      if (p.endsWith("/accounts_user")) {
        const row = { id: u.id, email: u.email, first_name: u.first_name, last_name: "Tester", mfa_enabled: false, created_at: "2026-01-01T00:00:00Z" };
        return (req.headers()["accept"] || "").includes("pgrst.object") ? json(row) : json([row]);
      }
      if (p.endsWith("/tenancy_workspacemember"))
        return json(opts.noWorkspaces ? [] : [{ role, workspace: { id: fx.workspace.id, name: fx.workspace.name, slug: fx.workspace.slug } }]);
      if (p.endsWith("/tenancy_brand")) return json(fx.brands);
    }
    log.push(`UNMOCKED ${req.method()} ${p}`);
    return json({});
  });
  return { log, bodies, unmocked: () => log.filter((l) => l.startsWith("UNMOCKED")) };
}

/** Establish a real Django session (cookie) in the page's browser context. */
export async function djangoLogin(page: Page, who: Who = "owner") {
  await page.request.get("/api/auth/csrf");
  const token = (await page.context().cookies()).find((c) => c.name === "csrftoken")?.value || "";
  const res = await page.request.post("/api/auth/login", {
    data: { email: fx.users[who].email, password: fx.password },
    headers: { "X-CSRFToken": token },
  });
  expect(res.ok(), `django login for ${who}`).toBeTruthy();
  const body = await res.json();
  expect(body.mfa_required, `fixture user ${who} must not have MFA enabled (reseed DB)`).toBe(false);
}

/** Standard authenticated setup: mocked Supabase session + real Django session. */
export async function signedIn(page: Page, who: Who = "owner", opts: SbOpts = {}) {
  const sb = await mockSupabase(page, { authed: who, ...opts });
  await djangoLogin(page, who);
  return sb;
}

export interface Diag {
  console: string[];
  pageErrors: string[];
  failedRequests: string[];
  badResponses: string[];
  dialogs: string[];
}

const LOG_DIR = path.join(ROOT, "results", "logs");

/** Extended test: auto-collects console errors, page errors, failed requests, HTTP>=400, dialogs. */
export const test = base.extend<{ diag: Diag }>({
  diag: [
    async ({ page }, use, testInfo) => {
      const d: Diag = { console: [], pageErrors: [], failedRequests: [], badResponses: [], dialogs: [] };
      page.on("console", (m) => {
        if (m.type() === "error" || m.type() === "warning") d.console.push(`[${m.type()}] ${m.text().slice(0, 300)}`);
      });
      page.on("pageerror", (e) => d.pageErrors.push(String(e).slice(0, 300)));
      page.on("requestfailed", (r) => d.failedRequests.push(`${r.method()} ${r.url()} :: ${r.failure()?.errorText}`));
      page.on("response", (r) => {
        if (r.status() >= 400) d.badResponses.push(`${r.status()} ${r.request().method()} ${r.url()}`);
      });
      page.on("dialog", async (dlg) => {
        d.dialogs.push(`${dlg.type()}: ${dlg.message()}`);
        await dlg.accept();
      });
      await use(d);
      fs.mkdirSync(LOG_DIR, { recursive: true });
      const name = testInfo.title.split(" ")[0].replace(/[^\w-]/g, "_");
      fs.writeFileSync(path.join(LOG_DIR, `${name}.json`), JSON.stringify({ title: testInfo.title, status: testInfo.status, ...d }, null, 2));
    },
    { auto: true },
  ],
});

export const brand1 = () => fx.brands[0];
export const brand2 = () => fx.brands[1];
export const goto = async (page: Page, p: string) => {
  await page.goto(p);
  await page.waitForLoadState("networkidle");
};

