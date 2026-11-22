# Smoke Test Report (Phase 13)

*2026-11-21.*

## 1. Local (isolated stack: Next production build :3100 → Django :8011, SQLite, synthetic data)

| Check | Result | How it was verified (beyond "HTTP 200") |
|---|---|---|
| Build completes | PASS | `next build`: 35 pages, type-check clean (`npx tsc --noEmit` exit 0); built twice (repo + isolated copy) |
| Application starts | PASS | `next start` + `manage.py runserver` |
| Login page loads | PASS | form controls present (e2e `01-auth`) |
| Registration page loads | PASS | e2e register flow creates user + workspace |
| Authentication works | PASS | login → `/me` 200 with the right user/workspaces; logout → old cookie 401 |
| Dashboard loads | PASS | `/api/w/<ws>/b/<brand>/shopify/stats/` → 60 orders, net 6,771,600 paise, funnel matches the seed |
| Protected routes protected | PASS | no cookie → `/login?next=…`; forged / expired cookie → 401 |
| Database reachable | PASS | local SQLite; hosted DB reachable for read-only catalog queries |
| Serverless functions respond | PASS (in-process) / BLOCKED (deployed) | all 7 handlers exercised by `deno task test` (64/64); no deployed function URL to call |
| Settings page loads | PASS | e2e `FE-SET-01/02` |
| 2FA enrollment page loads | PASS | e2e `FE-MFA-01` (QR + secret + input) |
| API integrations return expected results | FAIL (live) | all 4 stored credentials rejected by the providers (LIVE); see live report |
| Webhook endpoints respond correctly | PASS | signed → 200 + row; unsigned → 401; duplicate → `duplicate` |
| Data fetching works | PASS (local seed) | payments, logistics, shopify stats return seeded values |
| Inventory page loads | PASS (page) | renders; shows the honest "not available" state |
| Influencer page loads | PASS (page) | same |
| No critical console errors | PASS for the passing specs | `06-layout-routing` asserts no `pageerror`. Not asserted for the failing specs |

## 2. Staging / production

| Target | Result |
|---|---|
| `https://125east-dashboard.vercel.app` | **BLOCKED**: `404 DEPLOYMENT_NOT_FOUND` (Vercel) |
| `https://motion-islamic-starting-window.trycloudflare.com` (route.ts fallback) | **BLOCKED**: DNS does not resolve (quick tunnel gone) |
| `https://appropriations-aluminum-martial-guitar.trycloudflare.com` (`vercel.json` rewrite) | **BLOCKED**: DNS does not resolve |
| Supabase Auth (`/auth/v1/settings`) | reachable; settings read (sign-ups open, auto-confirm on) |
| Supabase Edge Functions (hosted) | not tested (deployment state unknown; would need a JWT) |

**To run staging smoke:** deploy the API to a stable host (not a quick tunnel), set `BACKEND_URL` on Vercel, redeploy, then run
`cd e2e && set E2E_BASE_URL=https://<staging-host> && npx playwright test 01-auth.spec.ts 06-layout-routing.spec.ts` with a seeded staging database (never production).

`scripts/smoke_staging.py` and `serverless/tests/smoke/smoke.ts` exist but need a reachable target.
