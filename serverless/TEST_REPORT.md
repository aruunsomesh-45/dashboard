# 125 EAST — Serverless Integration Test Report

- **Automated suite run:** 2026-11-20 18:43 UTC (`deno task report`)
- **Live smoke run:** 2026-11-20 18:40 UTC against `ybyroxyofqfpozvfedhc.supabase.co`
- **Machine-readable results:** `tests/results/summary.json`, `tests/results/junit.xml`, `tests/results/smoke.json`

## Executive summary

| Result | Count |
|---|---|
| Total test cases (leaf) | **164** |
| Passed | **160** |
| Failed | **0** |
| Skipped | **4** (all LIVE third-party API tests — no platform credentials on this machine) |

**Most important findings:**

- **None of the 7 Edge Functions are deployed.** Every one returns `404 NOT_FOUND`.
- **Before this work, no database write from any sync or webhook function could have succeeded.** They wrote columns that don't exist in the live database (verified live), and most ignored the error and reported `success: true`.
- **The documented frontend URL, `125east-dashboard.vercel.app`, returns `DEPLOYMENT_NOT_FOUND`.**

**What the 160 passing tests prove:** the rewritten functions behave correctly against your real schema, constraints, triggers and RLS policies, using synthetic API responses.

**What they do not prove:** that any live Shopify, Razorpay, Meta or Instagram account works. That has not been tested.

### How to read "mocked" vs "live"

| Label | Meaning |
|---|---|
| **MOCKED** | Upstream HTTP is a scripted `fetch` that throws on any un-scripted URL, so no request leaves the process. Proves the code path only. |
| **LOCAL DB** | A fresh in-process PostgreSQL (PGlite) built from `supabase/migrations/*.sql`, with real constraints, triggers, RLS policies and RPCs. It is not the hosted project, and no production data was read or written. |
| **LIVE** | A real network call to the hosted project or a third-party API. |

---

## Phase 10 — Component status

| Component | Status | Evidence |
|---|---|---|
| Supabase Auth | **PASS (live, health only)** | `GET /auth/v1/health` → 200 GoTrue, 621 ms. A user sign-in was **not** tested live (no test account credentials were supplied). |
| Shopify API | **NOT TESTED LIVE** · mocked PASS 10/10 | No `LIVE_SHOPIFY_*` credentials. Mocked: Link-header pagination, idempotent upsert, 401 → integration `error`, 429 Retry-After, timeout → 504, foreign-host `next` link refused. |
| Shopify webhook | **PASS (local DB)** 14/14 · NOT DEPLOYED | Real base64 HMAC-SHA256 over raw bytes, cross-checked against `node:crypto`. Covers valid, invalid, tampered, missing, wrong-brand, duplicate, malformed, oversize, and retry-after-failure cases. Live endpoint → 404. |
| Razorpay API | **NOT TESTED LIVE** · mocked PASS 4/4 | No `LIVE_RAZORPAY_*` credentials. Mocked: Basic auth, count/skip pagination (102 rows), status/method normalisation, re-sync idempotency, 401 handling. |
| Razorpay webhook | **PASS (local DB)** 8/8 · NOT DEPLOYED | Real hex HMAC-SHA256, `X-Razorpay-Event-Id` dedupe. API-key secret correctly rejected as webhook secret. Fails closed when no webhook secret is stored. Live endpoint → 404. |
| Meta Ads API | **NOT TESTED LIVE** · mocked PASS 5/5 | No `LIVE_META_*` credentials. Mocked: `paging.next` cursor, code 190 → `token_invalid`, code 200 → `permission`, foreign-host cursor refused. |
| Instagram API | **NOT TESTED LIVE** · mocked PASS 3/3 | No `LIVE_INSTAGRAM_TOKEN`. Per-capability permission report verified. **Persistence is not implemented:** there is no table for media or insights. |
| Database | **PASS (local DB + live schema)** 11/11 | All 16 migrations replay (with two documented shims). Unique keys, foreign keys, CHECK constraints, cascade delete, dedupe trigger and sync history all verified. **Live:** all 87 columns the functions write exist (10/10 tables). |
| Workspace isolation | **PASS (local DB)** 7/7 RLS + 29 security | Tenant A cannot read, insert, update or delete tenant B's rows. Ciphertext column is denied by grant (42501). Anonymous users see nothing. Cross-tenant function calls → 403 with no upstream call. |
| Dashboard E2E | **Service-level PASS 11/11 · browser E2E BLOCKED** | Dashboard RPC totals equal an independent SQL aggregate (3 orders, ₹2,860.00 gross over 30 days; 4 over 365). Browser E2E is blocked: no Vercel deployment, functions not deployed, and dashboard data still comes from the removed Django `/api`. |

### Per-suite totals (from `summary.json`)

| Suite | Kind | Total | Pass | Fail | Skip | Time |
|---|---|---|---|---|---|---|
| Unit: crypto / logger / signatures / mappers / http | MOCKED | 50 | 50 | 0 | 0 | 79 ms |
| Database schema + constraints | LOCAL DB | 11 | 11 | 0 | 0 | 1291 ms |
| Workspace isolation (RLS) | LOCAL DB | 7 | 7 | 0 | 0 | 49 ms |
| Shopify sync | MOCKED + LOCAL DB | 10 | 10 | 0 | 0 | 171 ms |
| Razorpay sync | MOCKED + LOCAL DB | 4 | 4 | 0 | 0 | 209 ms |
| Meta Ads sync | MOCKED + LOCAL DB | 5 | 5 | 0 | 0 | 59 ms |
| Instagram sync | MOCKED + LOCAL DB | 3 | 3 | 0 | 0 | 25 ms |
| test-connection | MOCKED + LOCAL DB | 8 | 8 | 0 | 0 | 20 ms |
| Shopify webhook | LOCAL DB | 14 | 14 | 0 | 0 | 90 ms |
| Razorpay webhook | LOCAL DB | 8 | 8 | 0 | 0 | 27 ms |
| Security | MOCKED + LOCAL DB | 29 | 29 | 0 | 0 | 99 ms |
| E2E workflows (service-level) | MOCKED + LOCAL DB | 11 | 11 | 0 | 0 | 146 ms |
| LIVE third-party APIs | LIVE | 4 | 0 | 0 | **4** | — |

### Live smoke results (`deno task smoke`)

| Check | Verdict | HTTP | Time |
|---|---|---|---|
| Auth health | PASS | 200 | 621 ms |
| Anonymous REST read of `tenancy_brand` | PASS (denied, 42501) | 401 | 425 ms |
| Schema contract — 10 tables / 87 columns | PASS | — | 97–1130 ms per table |
| test-connection, shopify-sync, razorpay-sync, meta-ads-sync, instagram-sync | **NOT_DEPLOYED** | 404 | 77–438 ms |
| webhook-shopify, webhook-razorpay | **NOT_DEPLOYED** | 404 | 92–243 ms |

**Actual record counts from live platforms:** none, because no live platform test ran. All record counts in this report come from synthetic data in an isolated database.

---

## Root-caused defects found and fixed

| # | Severity | Defect | Root cause | Fix | Proof |
|---|---|---|---|---|---|
| 1 | **Critical** | Every sync and webhook DB write failed | Functions wrote `external_id`, `gross_amount_minor`, `net_sales_minor`, `gateway`, `platform`, `date`, `purchases`, `roas`, and used `onConflict: brand_id,external_id`. None of these exist in the schema; it uses `provider` + `provider_id` and `gross_amount`, `net_sales`, `fact_date`, … **Verified on the live DB** (PostgREST 42703). | New `_shared/mappers.ts` writes the real columns; conflict key `brand_id,provider,provider_id` | `schema_rls` regression step; live smoke schema contract 10/10 |
| 2 | **Critical** | Syncs reported `success: true` with nothing saved | Upsert errors were ignored (`await …upsert()` with no error check). The Shopify sync counted every attempted row as "created". | `upsertCanonical()` throws on error; per-row failures counted; `partial` / `failed` statuses; HTTP 500 if nothing saved | "one bad order → partial" step |
| 3 | **Critical** | Functions could not serve requests once deployed | `index.ts` only did `export default handler`, with no `Deno.serve`, which the Supabase Edge Runtime needs to receive requests | Each `index.ts` now calls `Deno.serve(createHandler(defaultDeps()))`; logic lives in `handler.ts` | `deno check` of all entrypoints |
| 4 | High | Webhook data loss on transient failure | Event was logged `processed: true` **before** processing, so a failed write made every provider retry look like a duplicate | Process first (idempotent), log after; return 500 on failure so the provider retries | "RETRY: processing failure → 500 … retry succeeds" step |
| 5 | High | CHECK-constraint violations | Razorpay `captured` → `"success"` (not allowed); Shopify `authorized` / `partially_paid` (not allowed); `fulfillment_status: null` into a NOT NULL column | Status maps restricted to the schema's allowed values | mapper unit tests + contract steps |
| 6 | High | Dashboard RPC authorization guard was a no-op | `IF NOT (x = NULL OR false)` evaluates to NULL, so the `RAISE` never fired for non-members. RLS still hid the rows (no leak), but outsiders got a fake all-zero dashboard. | New migration `20261121000015_fix_commerce_stats_auth_guard.sql` (COALESCE). **Not applied to the live DB.** | E2E "workspace isolation" step failed before the fix, passes after |
| 7 | High | Admin client silently used the anon key | `createAdminClient()` fell back to the anon key when the service-role key was missing, so every privileged query was blocked by RLS | Throws a clear misconfiguration error | security step |
| 8 | High | Hard-coded encryption key fallback | `crypto.ts` fell back to a key committed in the repo | Removed; missing key → explicit error | crypto unit test |
| 9 | Medium | SSRF / token exfiltration via `test-connection` | `shop_domain` was user-controlled, so any authenticated user could make the function send `X-Shopify-Access-Token` to any host. Pagination links were also followed to any host. | Shop domain must match `*.myshopify.com`; Shopify and Meta `next` links restricted to their own host | mapper + test-connection + sync steps |
| 10 | Medium | Wrong HTTP statuses | Auth failures returned 400 or 500; any error became 500 | `HttpError` → 400/401/403/404/405/413/502/504 | security suite |
| 11 | Medium | Float money drift | `parseFloat("0.29") * 100 = 28.999…` | Decimal-string `toMinor()` | mapper unit test |
| 12 | Medium | `net_sales` double-counted discounts | Shopify `total_price` is already net of discounts; the code subtracted them again | `net_sales = total_price − tax − shipping` | mapper unit test (**behaviour change — please confirm this matches your P&L definition**) |
| 13 | Low | Pagination missing | Razorpay fetched one page; Meta ignored `paging.next` | Paginated with page caps | sync steps |
| 14 | Low | Logs could carry signatures / API keys | The redaction list lacked `apikey`, `signature`, `hmac` | Added; log-capture test asserts no token reaches the logs | security step |

---

## Outstanding issues (not fixed — need your decision or credentials)

1. **Deploy the functions.** Commands are in `README.md`. Required secrets: `SUPABASE_SERVICE_ROLE_KEY`, plus `INTEGRATION_ENCRYPTION_KEY`, which must be the key the existing ciphertext was encrypted with. Webhooks need `--no-verify-jwt`.
2. **Apply migration `20261121000015`** to the live DB (`supabase db push`). I did not apply it.
3. **Migration replay defects:**
   - `20261112000011` renames a function parameter with `CREATE OR REPLACE`, which Postgres rejects.
   - `public._schema_migrations` is never created by any migration.
   - A fresh `supabase db reset` would therefore fail. The test harness uses documented shims (`tests/db/pglite_db.ts`).
4. **The frontend still depends on the Django backend** for login, dashboards and the integrations list (`apiFetch('/api/…')` → Cloudflare tunnel). `backend/` was deleted earlier in this session, so those pages have no backend.
5. **`NEXT_PUBLIC_FUNCTIONS_URL=http://192.168.1.12:54321/functions/v1`** in `frontend/.env.local` is a LAN address. On Vercel it must be `https://ybyroxyofqfpozvfedhc.supabase.co/functions/v1`.
6. **Vercel:** `125east-dashboard.vercel.app` → `DEPLOYMENT_NOT_FOUND`, and there is no `.vercel` project link in the repo.
7. **Not implemented (not invented here):**
   - Shopify **products** sync
   - Meta **campaign**-level fetch
   - Instagram media/insights **persistence** (no table exists)
   - Webhook rate limiting (relies on the Supabase gateway)
8. **CORS** is `Access-Control-Allow-Origin: *`. This is acceptable with bearer tokens and no cookies, but a fixed origin list would be stricter.
9. **Pre-existing type error** in `frontend/src/context/AuthContext.tsx:116` (`window` narrowed to `never`). This is in your uncommitted changes; I did not touch it.

---

## Phase 1 — Endpoint inventory

All functions are `POST`, CORS-enabled (`OPTIONS` → 200), and have their logic in `supabase/functions/<name>/handler.ts`.

| Function | Auth | Required params | External platform / call | Tables written | Expected response | Status |
|---|---|---|---|---|---|---|
| `test-connection` | Supabase JWT (`verify_jwt=true`) + workspace membership | `integration_id` **or** `provider` + `credentials` (optional `workspace_id`, `brand_id`) | Shopify `GET /admin/api/2024-10/shop.json`; Razorpay `GET /v1/payments?count=1`; Meta `GET /v21.0/act_<id>`; Graph `GET /v21.0/me` | none | `{success, data: ConnectionTestResult}` | Implemented · **not deployed** |
| `shopify-sync` | JWT + membership | `workspace_id`, `brand_id` (UUIDs); `days` 1–365, `max_pages` 1–50 | `GET /admin/api/2024-10/orders.json` (Link pagination) | `commerce_customer`, `commerce_order`, `commerce_orderline`, `integrations_syncrun`, `integrations_integration` | counts + `status` success/partial | Implemented · **not deployed** · products not implemented |
| `razorpay-sync` | JWT + membership | `workspace_id`, `brand_id`; `days`, `max_pages` | `GET /v1/payments?count=100&skip&from` | `commerce_paymentattempt`, `integrations_syncrun`, `integrations_integration` | counts | Implemented · **not deployed** |
| `meta-ads-sync` | JWT + membership | `workspace_id`, `brand_id`; `days`, `max_pages` | `GET /v21.0/act_<id>/insights` (daily, `paging.next`) | `analytics_factadsdaily`, `integrations_syncrun`, `integrations_integration` | counts | Implemented · **not deployed** · campaigns not implemented |
| `instagram-sync` | JWT + membership | `workspace_id`, `brand_id` | `GET /me`, `/me/accounts`, `/<ig_id>/media` | `integrations_integration` only | account info + capabilities | Verification only · **not deployed** · no persistence |
| `webhook-shopify` | **No JWT**; HMAC `X-Shopify-Hmac-Sha256` (app client secret) | `?brand_id=<uuid>`; headers `X-Shopify-Topic`, `X-Shopify-Event-Id` | inbound | `integrations_webhookevent`, `commerce_customer`, `commerce_order`, `commerce_orderline` | `accepted` / `duplicate` / 401 / 400 / 413 / 500 | Implemented · **not deployed** |
| `webhook-razorpay` | **No JWT**; HMAC `X-Razorpay-Signature` (webhook secret) | `?brand_id=<uuid>`; header `X-Razorpay-Event-Id` | inbound | `integrations_webhookevent`, `commerce_paymentattempt` | same | Implemented · **not deployed** |

**Frontend callers**
- `frontend/src/lib/serverless.ts` → `invokeEdgeFunction()`, used by `integrations/page.tsx` (test-connection and the 4 syncs) and the new `/dev/tests`.
- All other pages call `apiFetch('/api/…')` → the Django proxy (see outstanding issue 4).

**Authentication**
- Supabase Auth (`supabase.auth.signInWithPassword` / `signUp` in `AuthContext`).
- Signup trigger `handle_new_auth_user()` provisions the account, workspace, owner membership, brand and subscription.
- Tenancy is enforced by RLS (`is_member_of_workspace`, `has_workspace_role`).

**Environment / secret references** (names only)

| Where | Names |
|---|---|
| Functions | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `INTEGRATION_ENCRYPTION_KEY` (or `SECRET_KEY`) |
| Frontend | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_FUNCTIONS_URL`, `BACKEND_URL` |

Per-brand platform credentials are stored AES-256-GCM-encrypted in `integrations_integration.encrypted_credentials`, which clients cannot select.

**Deployment URLs**
- Supabase: `https://ybyroxyofqfpozvfedhc.supabase.co` (live)
- Functions: `/functions/v1/*` (all 404)
- Vercel: `125east-dashboard.vercel.app` (not found)

---

## How to run

```bash
cd serverless
deno task test        # unit + local-DB suites (no network except package download)
deno task smoke       # live, read-only checks of the hosted project
deno task test:live   # live third-party APIs; set LIVE_* env vars (see tests/live/live_api.test.ts)
deno task report      # all of the above -> tests/results/summary.json (feeds /dev/tests)
```

For a fuller live smoke test, set `SMOKE_USER_JWT` (a test user's access token) and `SMOKE_INTEGRATION_IDS`. The smoke test then also runs authenticated checks and real `test-connection` calls. It never writes data.

The development dashboard is at **`/dev/tests`** in `next dev`. It returns 404 in production unless `ENABLE_TEST_DASHBOARD=true`.

## Safety notes

- No production row was written. The hosted project received only read-only requests: health, zero-row `select … limit=0` column probes, and unauthenticated POSTs that returned 404.
- RLS and authentication were never disabled. Signature verification is never bypassed; every webhook test signs with the platform's real algorithm.
- No secret is printed by any test, the smoke script, or the dashboard. A log-capture test asserts this for the sync path.
