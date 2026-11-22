# 125East Serverless Dashboard — Production Deployment Checklist

This checklist governs the isolated production deployment of the **125East Serverless Dashboard** to Vercel and Supabase. Non-serverless enterprise scale modules (Admin Dashboard, Influencer Management, Inventory Management) have been physically and logically isolated inside `scale/`.

---

## 1. Repository Restructuring
- [x] **Completed:** Audited repository layout and verified branch stability.
- [x] **Completed:** Created isolated `scale/` root architecture directory.
- [x] **Completed:** Established clean `serverless/` standard structure with `functions/`, `supabase/`, `config/`, and `tests/`.
- [x] **Completed:** Preserved working serverless functions, database helpers, and auth routines without code destruction.
- [x] **Completed:** Verified `.gitignore` covers environment files, database logs, and test artifacts.

---

## 2. Module Isolation
- [x] **Completed:** Moved Admin Dashboard (`frontend/src/app/super-admin`, `frontend/src/app/api/super-admin`, `frontend/src/components/super-admin`) to `scale/admin-dashboard/`.
- [x] **Completed:** Moved Influencer Management (`frontend/src/app/influencer`) to `scale/influencer-management/`.
- [x] **Completed:** Moved Inventory Management (`frontend/src/app/inventory`) to `scale/inventory-management/`.
- [x] **Completed:** Preserved shared server database client in `frontend/src/lib/supabaseServer.ts`.
- [x] **Completed:** Removed excluded modules from production sidebar navigation in `frontend/src/components/layout/DashboardShell.tsx`.
- [x] **Completed:** Removed Super Admin action pill from production sidebar.
- [x] **Completed:** Created isolated module `README.md` documentation inside each `scale/` subfolder.

---

## 3. Frontend Build Verification
- [x] **Completed:** Executed clean Next.js production build (`npm run build`).
- [x] **Completed:** Validated compilation: 22 production routes built cleanly with zero TypeScript or linting errors.
- [x] **Completed:** Verified excluded routes (`/super-admin`, `/inventory`, `/influencer`) do NOT exist in the production routing table.
- [x] **Completed:** Verified zero client-side bundles or chunks generated for excluded modules.
- [x] **Completed:** Verified production bundle size is lightweight (Shared first load JS: ~149 kB).

---

## 4. Backend/Serverless Configuration
- [x] **Completed:** Configured Deno Edge Runtime (`deno.json`, `local-gateway.ts`) for local verification.
- [x] **Completed:** Verified CORS headers in `serverless/supabase/functions/_shared/cors.ts` (supports `Authorization`, `apikey`, `Content-Type`).
- [x] **Completed:** Configured AES-256-GCM symmetric encryption for third-party OAuth access tokens and API secrets.
- [x] **Completed:** Enforced raw-body cryptographic signature verification for all incoming webhooks.
- [x] **Completed:** Implemented idempotent duplicate event detection in `integrations_webhookevent`.

---

## 5. Supabase Configuration
- [x] **Completed:** Configured Supabase project `ybyroxyofqfpozvfedhc`.
- [x] **Completed:** Verified schema contracts across 10 tables (`commerce_order`, `commerce_paymentattempt`, `integrations_integration`, etc.).
- [x] **Completed:** Verified Row Level Security (RLS) is active across all tenant tables.
- [x] **Completed:** Verified `public.get_user_effective_modules` stored procedure handles module resolution.
- [ ] **Pending Approval:** Deploy updated Edge Functions to live Supabase project via CLI (`supabase functions deploy`).

---

## 6. Environment Variables
- [x] **Completed:** Scoped client environment variables to `NEXT_PUBLIC_*` only.
- [x] **Completed:** Server-only secret `SUPABASE_SERVICE_ROLE_KEY` confirmed absent from client bundle.
- [x] **Completed:** Prepared Vercel production environment variable roster:
  - `NEXT_PUBLIC_SITE_URL`: Production domain URL
  - `NEXT_PUBLIC_SUPABASE_URL`: `https://ybyroxyofqfpozvfedhc.supabase.co`
  - `NEXT_PUBLIC_SUPABASE_ANON_KEY`: Supabase client anon public key
  - `NEXT_PUBLIC_FUNCTIONS_URL`: Supabase Edge Functions URL
  - `SUPABASE_SERVICE_ROLE_KEY`: Server-only secret key (Vercel Serverless Function scope)
  - `SECRET_KEY`: Master HMAC webhook verification secret
- [x] **Completed:** Prepared Supabase Edge Functions secret roster:
  - `ENCRYPTION_KEY`: 32-byte AES-256 master key
  - `SUPABASE_SERVICE_ROLE_KEY`: Service role key for database mutations

---

## 7. API Connectivity Testing
- [x] **Completed:** Shopify API: Validated connection handshake and store domain normalizer.
- [x] **Completed:** Razorpay API: Validated auth headers, pagination, and payment attempt ingest.
- [x] **Completed:** Meta Ads Graph API: Validated token classification, ad account ID sanitization, and metric aggregations.
- [x] **Completed:** Instagram Graph API: Validated business discovery and fallback handling for degraded permissions.
- [x] **Completed:** Executed automated 5-app runner (`test_five_apps.py`): 16 / 16 tests passing (100% success rate).

---

## 8. Webhook Testing
- [x] **Completed:** Shopify Webhook: Verified base64 HMAC-SHA256 signature check using raw payload bytes.
- [x] **Completed:** Razorpay Webhook: Verified hex-encoded HMAC-SHA256 signature check using raw payload bytes.
- [x] **Completed:** Webhook Tampering: Confirmed tampered payload or modified header receives immediate `HTTP 401 Unauthorized`.
- [x] **Completed:** Webhook Idempotency: Confirmed identical webhook resend is identified and deduplicated (`HTTP 200 { status: "duplicate" }`).

---

## 9. Unit Testing
- [x] **Completed:** Run `deno test -A tests/unit`: **50 passed, 0 failed (375ms)**.
  - Crypto round-trip & tamper rejection (6 tests): Passed
  - Logger sensitive data redaction (3 tests): Passed
  - Upstream data mappers & normalizers (17 tests): Passed
  - Webhook cryptographic signatures (14 tests): Passed
  - Upstream HTTP retry & exponential backoff (10 tests): Passed

---

## 10. Integration Testing
- [x] **Completed:** Verified Edge Function to Supabase PostgreSQL database data ingestion.
- [x] **Completed:** Verified multi-tenant workspace isolation (`user_id` & `workspace_id` scoping).
- [x] **Completed:** Verified auth token propagation between Next.js frontend, Edge Functions, and Supabase GoTrue.

---

## 11. Smoke Testing
- [x] **Completed:** Run `tests/smoke/smoke.ts`: **19 checks, 19 healthy, 0 failures**.
  - Supabase Auth `/auth/v1/health`: Healthy (HTTP 200)
  - Supabase REST RLS denial check: Healthy (HTTP 401 / code 42501)
  - 10 PostgreSQL schema contract tables: Healthy
  - 7 Edge Function deployment & auth barriers: Healthy

---

## 12. End-to-End Testing
- [x] **Completed:** Executed Playwright E2E suite (`e2e/`): 106 tests passing.
- [x] **Completed:** Verified login flow, workspace switcher, and dashboard metric cards.
- [x] **Completed:** Verified module guards display clean fallback states for unconfigured integrations.

---

## 13. Security Audit
- [x] **Completed:** Verified zero secrets committed in Git index.
- [x] **Completed:** Verified `SUPABASE_SERVICE_ROLE_KEY` and third-party API tokens never bundled in client JS.
- [x] **Completed:** Verified strict timing-safe comparison (`timingSafeEqual`) on all webhook signature authentications.
- [x] **Completed:** Verified cross-workspace data access is strictly forbidden by PostgreSQL Row Level Security.
- [x] **Completed:** Removed hardcoded Cloudflare quick tunnel URLs from `vercel.json`.

---

## 14. Vercel Deployment
- [ ] **Pending Approval:** Link production project to Vercel via CLI / Git integration.
- [ ] **Pending Approval:** Configure Root Directory as `frontend` (or repository root with build command `npm --prefix frontend run build`).
- [ ] **Pending Approval:** Set Environment Variables in Vercel Project Settings.
- [ ] **Pending Approval:** Trigger production deployment (`vercel --prod`).

---

## 15. Supabase Deployment
- [ ] **Pending Approval:** Set production secrets via CLI (`supabase secrets set ...`).
- [ ] **Pending Approval:** Deploy 7 serverless functions:
  - `test-connection`
  - `shopify-sync`
  - `razorpay-sync`
  - `meta-ads-sync`
  - `instagram-sync`
  - `webhook-shopify`
  - `webhook-razorpay`

---

## 16. Production Verification
- [ ] **Pending Approval:** Verify HTTPS endpoint response on production Vercel URL.
- [ ] **Pending Approval:** Execute live smoke test against production domain.
- [ ] **Pending Approval:** Confirm webhooks receive events from Shopify and Razorpay live endpoints.

---

## 17. Rollback Procedure
- [x] **Completed:** Defined rollback trigger criteria (HTTP 5xx error rate > 1%, webhook validation failure).
- [x] **Completed:** Defined Vercel instant rollback: Roll back to previous deployment ID with 1-click in Vercel Dashboard.
- [x] **Completed:** Preserved working git backup reference: `refs/backups/pre-qa-2026-11-21`.
