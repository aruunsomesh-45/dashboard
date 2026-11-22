/**
 * LIVE smoke test for the deployed Supabase project. Read-only: it never writes data.
 *
 *   deno task smoke                      (from serverless/)
 *
 * Env (all optional except the URL/anon key, which default to frontend/.env.local values):
 *   SUPABASE_URL, SUPABASE_ANON_KEY
 *   SMOKE_USER_JWT            a real user's access token -> enables authenticated checks
 *   SMOKE_INTEGRATION_IDS     comma-separated integration ids to run test-connection against
 *
 * A function is never reported OPERATIONAL just because it answered 200. The verdicts are:
 *   NOT_DEPLOYED          gateway answered 404 NOT_FOUND
 *   AUTH_NOT_ENFORCED     answered 2xx to an unauthenticated call (security failure)
 *   DEPLOYED_AUTH_OK      deployed and rejects unauthenticated calls; functional state unknown
 *   OPERATIONAL           authenticated call returned a verified, well-formed success
 *   FAILED                deployed but erroring
 * Secrets are never printed; tokens are only sent in headers.
 */

const FUNCTIONS = ["test-connection", "shopify-sync", "razorpay-sync", "meta-ads-sync", "instagram-sync"] as const;
const WEBHOOKS = ["webhook-shopify", "webhook-razorpay"] as const;

/** Every column the Edge Functions write, by table. Verified live via PostgREST error codes. */
export const SCHEMA_CONTRACT: Record<string, string[]> = {
  commerce_order: ["workspace_id", "brand_id", "provider", "provider_id", "order_number", "customer_id", "currency", "gross_amount", "discount_amount", "tax_amount", "shipping_amount", "net_sales", "financial_status", "fulfillment_status", "cancelled_at", "source_created_at", "source_updated_at"],
  commerce_customer: ["workspace_id", "brand_id", "provider", "provider_id", "first_name", "last_name", "email", "phone", "source_created_at", "source_updated_at"],
  commerce_orderline: ["order_id", "title", "sku", "quantity", "price_minor", "total_discount_minor"],
  commerce_paymentattempt: ["workspace_id", "brand_id", "provider", "provider_id", "amount_minor", "currency", "status", "method", "gateway_order_id", "error_code", "error_description", "source_created_at"],
  analytics_factadsdaily: ["workspace_id", "brand_id", "fact_date", "spend_minor", "impressions", "clicks", "attributed_conversions", "attributed_revenue_minor"],
  integrations_integration: ["id", "workspace_id", "brand_id", "provider", "status", "account_identifier", "encrypted_credentials", "last_synced_at", "last_error_message"],
  integrations_syncrun: ["workspace_id", "brand_id", "integration_id", "status", "resource", "started_at", "finished_at", "records_processed", "records_created", "records_updated", "error_message"],
  integrations_webhookevent: ["workspace_id", "brand_id", "provider", "event_id", "topic", "raw_body", "headers", "processed", "processed_at"],
  tenancy_workspacemember: ["workspace_id", "user_id", "role"],
  tenancy_brand: ["id", "workspace_id"],
};

async function loadDefaults() {
  const out: Record<string, string> = {};
  try {
    const txt = await Deno.readTextFile(new URL("../../../frontend/.env.local", import.meta.url));
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  } catch { /* optional */ }
  return out;
}

interface Check { component: string; check: string; verdict: string; http: number | null; ms: number; detail: string }

async function timed(url: string, init: RequestInit = {}): Promise<{ status: number | null; ms: number; body: any; text: string; headers: Headers | null; error?: string }> {
  const t0 = performance.now();
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
    const text = await res.text();
    let body: any = null;
    try { body = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, ms: Math.round(performance.now() - t0), body, text, headers: res.headers };
  } catch (e) {
    return { status: null, ms: Math.round(performance.now() - t0), body: null, text: "", headers: null, error: (e as Error).message };
  }
}

export async function runSmoke(): Promise<{ checks: Check[]; startedAt: string; target: string }> {
  const defaults = await loadDefaults();
  const url = (Deno.env.get("SUPABASE_URL") || defaults.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/+$/, "");
  const anon = Deno.env.get("SUPABASE_ANON_KEY") || defaults.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
  const userJwt = Deno.env.get("SMOKE_USER_JWT") || "";
  const integrationIds = (Deno.env.get("SMOKE_INTEGRATION_IDS") || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!url || !anon) throw new Error("SUPABASE_URL / SUPABASE_ANON_KEY not available");

  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);
  const fnBase = Deno.env.get("FUNCTIONS_URL") || defaults.NEXT_PUBLIC_FUNCTIONS_URL || `${url}/functions/v1`;
  const fnUrl = (n: string) => `${fnBase.replace(/\/+$/, "")}/${n}`;

  // 1. Platform reachability
  const authHealth = await timed(`${url}/auth/v1/health`, { headers: { apikey: anon } });
  add({ component: "Supabase Auth", check: "GET /auth/v1/health", verdict: authHealth.status === 200 ? "PASS" : "FAIL", http: authHealth.status, ms: authHealth.ms, detail: authHealth.error ?? (authHealth.body?.name || authHealth.text.slice(0, 80)) });

  const rest = await timed(`${url}/rest/v1/tenancy_brand?select=id&limit=1`, { headers: { apikey: anon } });
  const restOk = rest.status === 200 || rest.body?.code === "42501";
  add({ component: "Supabase REST", check: "anon read of tenancy_brand is denied/empty", verdict: restOk && !(Array.isArray(rest.body) && rest.body.length) ? "PASS" : "FAIL", http: rest.status, ms: rest.ms, detail: rest.body?.code ? `code ${rest.body.code}` : `rows=${Array.isArray(rest.body) ? rest.body.length : "?"}` });

  // 2. Live schema contract (zero-row selects; 42703 = column missing, 42501 = exists but not granted to anon)
  for (const [table, cols] of Object.entries(SCHEMA_CONTRACT)) {
    const missing: string[] = [];
    let ms = 0;
    for (const c of cols) {
      const r = await timed(`${url}/rest/v1/${table}?select=${c}&limit=0`, { headers: { apikey: anon } });
      ms += r.ms;
      if (r.body?.code === "42703" || r.body?.code === "42P01" || r.body?.code === "PGRST205") missing.push(c);
    }
    add({ component: "Schema contract", check: table, verdict: missing.length ? "FAIL" : "PASS", http: null, ms, detail: missing.length ? `missing: ${missing.join(", ")}` : `${cols.length} columns present` });
  }

  // 3. Functions: deployment + auth enforcement (+ functional check when a user JWT is supplied)
  for (const fn of FUNCTIONS) {
    const pre = await timed(fnUrl(fn), { method: "OPTIONS", headers: { Origin: "https://125east-dashboard.vercel.app", "Access-Control-Request-Method": "POST" } });
    const noAuth = await timed(fnUrl(fn), { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const anonOnly = await timed(fnUrl(fn), { method: "POST", headers: { "Content-Type": "application/json", apikey: anon, Authorization: `Bearer ${anon}` }, body: "{}" });
    let verdict: string;
    if (noAuth.status === 404 && noAuth.body?.code === "NOT_FOUND") verdict = "NOT_DEPLOYED";
    else if (noAuth.status === null) verdict = "FAILED";
    else if ((noAuth.status ?? 0) < 300 || (anonOnly.status ?? 0) < 300) verdict = "AUTH_NOT_ENFORCED";
    else if (noAuth.status === 401 && anonOnly.status === 401) verdict = "DEPLOYED_AUTH_OK";
    else verdict = "FAILED";
    add({
      component: fn,
      check: "deployment + auth enforcement",
      verdict,
      http: noAuth.status,
      ms: noAuth.ms,
      detail: `no-auth=${noAuth.status} anon-key-as-user=${anonOnly.status} preflight=${pre.status}${noAuth.body?.message ? ` (${String(noAuth.body.message).slice(0, 60)})` : ""}${noAuth.body?.error ? ` (${String(noAuth.body.error).slice(0, 60)})` : ""}`,
    });

    if (userJwt && verdict === "DEPLOYED_AUTH_OK") {
      const bad = await timed(fnUrl(fn), { method: "POST", headers: { "Content-Type": "application/json", apikey: anon, Authorization: `Bearer ${userJwt}` }, body: '{"workspace_id":"not-a-uuid","brand_id":"x"}' });
      add({ component: fn, check: "authenticated invalid input -> 400", verdict: bad.status === 400 ? "PASS" : "FAIL", http: bad.status, ms: bad.ms, detail: String(bad.body?.error ?? "").slice(0, 100) });
    }
  }

  for (const id of integrationIds) {
    if (!userJwt) break;
    const r = await timed(fnUrl("test-connection"), { method: "POST", headers: { "Content-Type": "application/json", apikey: anon, Authorization: `Bearer ${userJwt}` }, body: JSON.stringify({ integration_id: id }) });
    const d = r.body?.data;
    const ok = r.status === 200 && d?.connection_status === "connected";
    add({ component: `integration ${id.slice(0, 8)}`, check: `test-connection (${d?.integration_name ?? "?"})`, verdict: ok ? "OPERATIONAL" : "FAIL", http: d?.http_status ?? r.status, ms: d?.response_time ?? r.ms, detail: ok ? `account=${d.account_info?.name ?? d.account_info?.identifier ?? "?"} records=${d.records_fetched}` : String(d?.error_message ?? r.body?.error ?? r.error ?? "").slice(0, 120) });
  }

  // 4. Webhook endpoints: must exist, reject unsigned calls, never 2xx without a signature
  for (const fn of WEBHOOKS) {
    const unsigned = await timed(`${fnUrl(fn)}?brand_id=00000000-0000-0000-0000-000000000000`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const badBrand = await timed(`${fnUrl(fn)}?brand_id=not-a-uuid`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    let verdict: string;
    if (unsigned.status === 404 && unsigned.body?.code === "NOT_FOUND") verdict = "NOT_DEPLOYED";
    else if ((unsigned.status ?? 0) >= 200 && (unsigned.status ?? 0) < 300) verdict = "AUTH_NOT_ENFORCED";
    else if (unsigned.status === 401 && badBrand.status === 400) verdict = "DEPLOYED_AUTH_OK";
    else verdict = "FAILED";
    add({ component: fn, check: "reachable without JWT + rejects unsigned", verdict, http: unsigned.status, ms: unsigned.ms, detail: `unsigned=${unsigned.status} bad-brand=${badBrand.status}${unsigned.body?.error ? ` (${String(unsigned.body.error).slice(0, 60)})` : ""}` });
  }

  return { checks, startedAt: new Date().toISOString(), target: new URL(url).host };
}

if (import.meta.main) {
  const res = await runSmoke();
  const out = new URL("../results/smoke.json", import.meta.url);
  await Deno.mkdir(new URL("../results/", import.meta.url), { recursive: true });
  await Deno.writeTextFile(out, JSON.stringify(res, null, 2));
  console.log(`Smoke target: ${res.target}  (${res.startedAt})`);
  for (const c of res.checks) {
    console.log(`${c.verdict.padEnd(18)} ${c.component.padEnd(26)} ${c.check.padEnd(46)} http=${String(c.http ?? "-").padEnd(4)} ${String(c.ms).padStart(5)}ms  ${c.detail}`);
  }
  const bad = res.checks.filter((c) => !["PASS", "OPERATIONAL", "DEPLOYED_AUTH_OK"].includes(c.verdict));
  console.log(`\n${res.checks.length} checks, ${res.checks.length - bad.length} healthy, ${bad.length} not healthy. Written to tests/results/smoke.json`);
  Deno.exit(bad.length ? 1 : 0);
}
