# 125East — Production Readiness Report

*Audit date: 2026-11-21 · Scope: `main` @ `dfe480a` plus the uncommitted working tree · Auditor: Claude (Opus 5.5) in Claude Code. Every result below comes from tests or probes that were actually run. BLOCKED and SKIPPED items are reported as such, never as passed.*

---

## 1. Executive summary

**Overall health: core application code is in reasonable shape and was hardened today, but the deployment and hosted database are not safe, and two advertised features don't exist.**

- **Recommendation: NOT READY FOR PRODUCTION** (see §7).
- **Critical defects found: 4.** Three are fixed and retested. **One remains open on the hosted database**: anyone on the internet can sign up through the public Supabase Auth API (sign-ups open, no email confirmation) and, because a security migration was never applied, **mark their own account super-admin or switch off their own 2FA** via PostgREST. The fix is written and tested on a replica (`supabase/migrations/20261121150100_…`) but needs your approval to apply.
- **Major (P1) defects: 12**, 7 fixed, 5 open. Open: production served from a developer machine through an ephemeral tunnel with `DEBUG=True`; super-admin console has no second factor; serverless "Test connection" / Razorpay / Instagram sync need a Supabase session the app no longer issues; all four live integrations hold invalid credentials; Inventory and Influencer attribution are not implemented.
- **Remaining blockers for live verification:** no reachable deployment (`125east-dashboard.vercel.app` → `DEPLOYMENT_NOT_FOUND`, both Cloudflare tunnels gone); invalid Shopify / Razorpay / Meta / Instagram credentials; no physical phone scan of the 2FA QR.

## 2. Test results

| Category | Total | Passed | Failed | Blocked | Skipped |
|---|---:|---:|---:|---:|---:|
| Unit tests (backend pytest 666 + serverless Deno 64) | 730 | 694 | 36 | 0 | 0 |
| Authentication | 20 | 18 | 1 | 0 | 1 |
| Google Authenticator | 13 | 11 | 1 | 1 | 0 |
| Database and RLS | 16 | 13 | 2 | 1 | 0 |
| Serverless functions | 65 | 64 | 0 | 1 | 0 |
| API integrations (LIVE) | 4 | 0 | 4 | 0 | 0 |
| Webhooks | 18 | 17 | 0 | 1 | 0 |
| Data synchronization | 25 | 23 | 1 | 1 | 0 |
| Inventory | 11 | 1 | 0 | 9 | 1 |
| Influencer attribution | 13 | 0 | 0 | 12 | 1 |
| End-to-end (Playwright) | 140 | 106 | 34 | 0 | 0 |
| Smoke tests (local 17 + staging 5) | 22 | 17 | 1 | 4 | 0 |
| Security (checklist areas) | 19 | 9 | 9 | 0 | 1 |
| Performance | 14 | 8 | 0 | 6 | 0 |

Notes:
- **Unit:** the 36 failures are all in `backend/tests/test_metrics.py`, a contract written ahead of the implementation: brand-timezone day buckets, previous-period comparison, freshness flag, lakh/crore formatting, UPI drop-off, NDR/RTO ratio definitions. Baseline was 581 passed / 49 failed (backend) and 53 passed / 7 failed (serverless).
- **Live API:** the four failures are credential problems confirmed against the real providers, not code failures (mocked suites pass).
- **E2E:** of the 34 failures, 12 are harness/test drift, 13 are product defects/gaps (mostly missing error states, a hardcoded "+18.4 %" KPI, no pagination control), and 9 timeouts were not root-caused (see `e2e-test-report.md`).
- **Security:** the failures are dominated by the hosted-DB privilege drift and infrastructure settings.

## 3. API integration status

| | Shopify | Razorpay | Meta Ads | Instagram |
|---|---|---|---|---|
| Credential validation | LIVE: **wrong token type stored** (`shpss_` API secret instead of `shpat_` Admin token); refused before calling | LIVE: **401 Authentication failed** | LIVE: **400 token_invalid** | LIVE: **400 token_invalid** |
| Live API calls | not sent (above) | ✓ called (140 ms) | ✓ called (218 ms) | ✓ called (275 ms) |
| Data retrieval | MOCKED ✓ / LIVE blocked | MOCKED ✓ / LIVE blocked | MOCKED ✓ / LIVE blocked | MOCKED ✓ / LIVE blocked |
| Database persistence | MOCKED ✓ (idempotent) | MOCKED ✓ | MOCKED ✓ | MOCKED ✓ |
| Dashboard rendering | LOCAL ✓ (seeded data via API; UI assertion hit a test-encoding bug) | LOCAL ✓ (e2e) | LOCAL partial | — |
| Webhook delivery | LOCAL ✓ signed / dup / retry; provider-originated BLOCKED | LOCAL ✓ incl. e2e to UI; provider-originated BLOCKED | n/a | n/a |
| End-to-end verified | **No** | **No** | **No** | **No** |

Hosted sync history agrees: 5 of 5 sync runs failed, all 4 integrations in `error`, `last_synced_at` never set. No SANDBOX environment was available for any provider.

## 4. Google Authenticator status

| Item | Status |
|---|---|
| QR generation | PASS (valid `otpauth://totp` URI, PNG, unique secret) |
| QR scanning (phone) | **BLOCKED** (manual step) |
| OTP verification | PASS (server-side, ±1 step, replay-protected) |
| 2FA enrollment | PASS (enabled only after a correct code; 10 recovery codes) |
| Login enforcement | **was FAILING (P0-1: bypassed entirely)** → PASS after the restore; browser-verified |
| Invalid OTP rejection | PASS (empty / short / long / letters / wrong / reused / expired) |
| Recovery | PASS (single-use; regenerate needs password) |
| Secret storage | **was FAILING (plaintext copy, P1-6)** → PASS (Fernet only) |
| Bypass protection | App: PASS (direct URL / API before code → 401 / `/login`). **Hosted DB: FAIL until `20261121150100` is applied** (a client can set its own `mfa_enabled=false` or insert recovery codes) |

## 5. Security findings

| ID | Sev | Feature | Reproduction (safe) | Root cause | Fix | Retest |
|---|---|---|---|---|---|---|
| P0-1 | Critical | Login / 2FA | log in as a 2FA user with the working-tree frontend → lands without an OTP prompt (Supabase mocked) | uncommitted switch to `supabase.auth.signInWithPassword` | restored the Django session + TOTP `AuthContext`, middleware and proxy (owner-approved) | browser: password → challenge; APIs 401 until the code; correct code → dashboard ✓ |
| P0-4 | Critical | Hosted DB / super-admin / 2FA | replica with the hosted grants: `SET ROLE authenticated; UPDATE accounts_user SET is_superuser=true WHERE id=<self>` succeeds | `20261110000011_security_hardening.sql` never applied on the hosted project + open, auto-confirmed sign-ups | `20261121150100_reassert_client_column_privileges.sql` (least-privilege grants + guard trigger) | replica ✓ (exploit reproduced first, then blocked). **Hosted: NOT APPLIED** |
| P1-5 | High | 2FA setup | with a session, `POST mfa/setup` while enabled → new secret returned; login then accepted it | setup overwrote the confirmed secret; challenge preferred it | 409 while enabled; challenge uses only the confirmed secret | `test_re_enrollment_while_enabled_is_refused` ✓ |
| P1-6 | High | 2FA storage | confirm → `accounts_user.mfa_secret` held plaintext | dual write | encrypted only | `test_secret_is_stored_encrypted_only` ✓ |
| P1-11 | High | 2FA brute force | rotate `X-Forwarded-For`, mint new challenges | IP-only throttle on a spoofable key | per-account lockout 10 / 15 min; `DRF_NUM_PROXIES` | `test_per_account_lockout_survives_ip_rotation` ✓ |
| P1-20 | High | Deployment | `vercel.json`/proxy → quick tunnel → `runserver` with dev settings, `DEBUG=True`, prod DB | ad-hoc hosting | **open** (see §8) | — |
| P1-21 | High | API proxy | backend 502 on a POST → request re-sent to a hardcoded second host | blanket fallback | fallback only for GET/HEAD/OPTIONS; `DISABLE_BACKEND_FALLBACK` | code review + isolated e2e run with fallback disabled ✓ |
| P1-12 | High | Super-admin | super-admin API accepts an `aal1` JWT | no second-factor check | **open** | — |
| P2-17/22 | Medium | Module permissions | anon could call `get_user_effective_modules(<any user>)`; tables lacked RLS in the migration | migration omissions | `20261121150000_harden_module_permissions.sql` | `module_permissions.test.ts` ✓ (not applied to hosted) |
| P2-23..26 | Medium | DB role BYPASSRLS, weak Supabase password policy, console email backend, vulnerable dependencies (Next 14.2.35 critical; Django 5.1.15, DRF 3.17.2 advisories) | see `security-audit-report.md` | — | **open** | — |
| P3 | Low | error-detail leaks (fixed in Edge + proxy), public Swagger, challenge token in URL, `/dev` public (fixed), forged-cookie middleware (fixed) | | | | |

## 6. Defect register

| ID | Pri | File / function | Root cause | Fix | Retest |
|---|---|---|---|---|---|
| P0-1 | P0 | `frontend/src/context/AuthContext.tsx`, `middleware.ts`, `app/api/[[...path]]/route.ts` | Supabase password login bypassed TOTP; session not visible to middleware/Django; proxy forced `/auth/me` → 401 | restored the Django session flow, kept the new fields | **PASS** (browser + e2e 01/07: 46/46) |
| P0-2 | P0 | `serverless/…/_shared/auth.ts` `requireModuleAccess` | JSONB object treated as an array → crash | `isModuleEnabled()` | **PASS** (64/64) |
| P0-3 | P0 | `backend/config/__init__.py` (missing) | Celery app never loaded → webhook processing tried AMQP | added the module | **PASS** (147 webhook tests) |
| P0-4 | P0 | hosted DB grants on `accounts_user`, `accounts_mfarecoverycode`, `integrations_integration` | migration drift | migration `20261121150100` | **PASS on replica; OPEN on hosted** |
| P1-4 | P1 | `backend/apps/integrations/webhook_views.py` | unprocessed redelivery answered `duplicate` | re-enqueue (`retrying`) | **PASS** |
| P1-5 | P1 | `accounts/views.py` `MFASetupView`, `MFAChallengeView` | re-setup overwrote the confirmed secret | 409 + confirmed-secret helper | **PASS** |
| P1-6 | P1 | `accounts/views.py` `MFAConfirmView` | plaintext secret column | stop writing it | **PASS** |
| P1-7 | P1 | `integrations/views.py`, `analytics/views.py` | cancelled orders counted as sales | exclude `cancelled_at` | **PASS** |
| P1-8 | P1 | `frontend/src/app/inventory/page.tsx`, `influencer/page.tsx` | hardcoded fake metrics | honest empty state | **PASS** (visual / code) |
| P1-11 | P1 | `accounts/services.py`, `views.py`, `settings/base.py` | spoofable throttle, no account lockout | lockout + `DRF_NUM_PROXIES` | **PASS** |
| P1-12 | P1 | `frontend/src/lib/serverAdmin.ts` | no 2FA for super-admin; console unreachable after the restore | — | **OPEN** |
| P1-13 | P1 | `frontend/src/app/integrations/page.tsx`, `lib/serverless.ts` | Edge Functions need a Supabase JWT | Shopify + Meta fall back to Django (Meta added today) | **PARTIAL / OPEN** |
| P1-20 | P1 | `vercel.json`, `route.ts`, `backend/.env` | tunnel + dev settings in production | — | **OPEN** |
| P1-21 | P1 | `route.ts` | POST replay on fallback | idempotent-only fallback | **PASS** |
| P1-32 | P1 | hosted `integrations_integration` | invalid / wrong-type credentials | re-enter credentials | **OPEN (operational)** |
| P1-33 | P1 | inventory, influencer attribution | not implemented | — | **OPEN (feature gap)** |
| P2-9 | P2 | `analytics/views.py` | unpaid orders in "to be shipped" | `financial_status="paid"` | **PASS** |
| P2-10 | P2 | `accounts/services.py` | replay state per user, not per secret | secret-tagged replay key, step reset | **PASS** |
| P2-14 | P2 | auth | no password lockout | — | OPEN |
| P2-17, P2-22 | P2 | module-permission migration | anon RPC, no RLS | migration `20261121150000` | PASS on replica / not applied |
| P2-18 | P2 | Django + Edge webhooks | duplicate stacks, different dedupe keys | — | OPEN (register one) |
| P2-23..26 | P2 | see security report | | | OPEN |
| P2-34 | P2 | metrics | brand-timezone days, NDR/RTO definitions | — | OPEN (36 tests) |
| P2-35 | P2 | dashboard UI | missing error states, static "+18.4 %" | — | OPEN |
| P3-16, P3-27, P3-30, P3-31 | P3 | Edge handler, proxy, middleware | error leaks, public `/dev`, forged cookie | fixed | PASS |
| P3-19, P3-28, P3-29 | P3 | Edge Shopify domain check, Swagger, challenge token in URL | | — | OPEN |

## 7. Production readiness decision

# **NOT READY FOR PRODUCTION**

Reasons (any one is sufficient):
1. **P0-4 is live on the hosted database**: a stranger can grant themselves super-admin and disable their own 2FA.
2. Production is configured to run on a developer machine through an ephemeral tunnel with `DEBUG=True` and dev security settings, and that path is currently down.
3. No integration is verified working against a live provider (all credentials invalid).
4. Two advertised modules (Inventory, Influencer attribution) do not exist.

## 8. Final handover

### Report files
`reports/architecture-audit.md` · `reports/api-endpoint-inventory.md` · `reports/database-and-rls-audit.md` · `reports/unit-test-report.md` · `reports/authentication-test-report.md` · `reports/google-authenticator-2fa-report.md` · `reports/database-security-rls-report.md` · `reports/serverless-function-test-report.md` · `reports/live-api-integration-report.md` · `reports/webhook-test-report.md` · `reports/data-fetching-sync-report.md` · `reports/inventory-test-report.md` · `reports/influencer-attribution-test-report.md` · `reports/e2e-test-report.md` · `reports/smoke-test-report.md` · `reports/security-audit-report.md` · `reports/performance-reliability-report.md` · `reports/PRODUCTION_READINESS_REPORT.md`

### Test commands
```
# backend (isolated SQLite via config.settings.test)
cd backend && ..\.venv\Scripts\python -m pytest -q
# serverless unit + DB/function tests (PGlite, mocked upstream)
cd serverless && deno task test
# serverless LIVE (read-only; needs LIVE_* env vars; isolated DB)
cd serverless && deno task test:live
# frontend
cd frontend && npx tsc --noEmit && npm run build
# e2e (ISOLATED stack only: backend copy without .env on SQLite + frontend build with DISABLE_BACKEND_FALLBACK=true)
cd e2e && set E2E_BASE_URL=http://localhost:3100 && npx playwright test
```
Do **not** run `e2e/reset_stack.ps1` while your own Django uses :8001: it kills whatever listens there.

### Results (final run)
Backend 630 ✓ / 36 ✗ · Serverless 64 ✓ / 0 ✗ (120 steps) · Type-check ✓ · Build ✓ · E2E 106 ✓ / 34 ✗.

### Files modified
- **Backend:** `apps/accounts/{views,services,serializers}.py`, `apps/analytics/views.py`, `apps/integrations/{views,webhook_views}.py`, `config/settings/base.py`; **new** `config/__init__.py`.
- **Backend tests:** `tests/{conftest,test_webhooks,test_auth_and_mfa,test_cross_tenant}.py`, `tests/security/test_webhooks.py`; **new** `tests/test_mfa_hardening.py`.
- **Frontend:** `src/context/AuthContext.tsx`, `src/middleware.ts`, `src/app/api/[[...path]]/route.ts`, `src/app/integrations/page.tsx`, `src/app/inventory/page.tsx`, `src/app/influencer/page.tsx`.
- **Serverless** (directory preserved): `supabase/functions/_shared/{auth,handler}.ts`, `tests/db/schema_rls.test.ts`; **new** `tests/db/{module_permissions,privileges}.test.ts`.
- **E2E harness:** `e2e/tests/helpers.ts` (browser-like Origin/Referer on the API login).
- **Backups before any change:** git ref `refs/backups/pre-qa-2026-11-21` (tracked files) and `backups/pre-qa-untracked-2026-11-21.tgz` (untracked files).

### Database migrations created (NOT applied anywhere except local replicas)
- `supabase/migrations/20261121150000_harden_module_permissions.sql`
- `supabase/migrations/20261121150100_reassert_client_column_privileges.sql`

### Environment variables (names only)
New: `DRF_NUM_PROXIES` (Django), `DISABLE_BACKEND_FALLBACK` (Next). Recommended: `MFA_ENCRYPTION_KEY`. Full list in `architecture-audit.md` §5.

### Exact steps before production deployment
1. **Today:** apply `20261121150000` and `20261121150100` to the hosted project (review first; both idempotent), record them in `_schema_migrations`, then run the abuse audit query in `database-security-rls-report.md` §2.
2. In Supabase Auth: turn on email confirmation, raise the minimum password length to ≥ 10, and disable public sign-ups unless they are needed.
3. Host Django properly (container/VM/PaaS) with `DJANGO_SETTINGS_MODULE=config.settings.prod`, a real `SECRET_KEY`, `INTEGRATION_ENCRYPTION_KEY`, `ALLOWED_HOSTS`, `CORS_ALLOWED_ORIGINS`, SMTP `EMAIL_*`, `SENTRY_DSN`, and `DRF_NUM_PROXIES` matching the proxy chain. Point Vercel's `BACKEND_URL` at it, set `DISABLE_BACKEND_FALLBACK=true`, and delete the hardcoded tunnel URLs from `vercel.json` and `route.ts`.
4. Decide the super-admin login path (Django staff + TOTP, or Supabase with `aal2` enforced in `verifySuperAdmin`), and bridge the Edge Functions (a Django-issued token, or Django equivalents for test-connection / Razorpay / Instagram sync).
5. Re-enter valid Shopify (`shpat_`), Razorpay, Meta and Instagram credentials; run `deno task test:live`; register **one** webhook URL per provider and send each provider's test event.
6. Scan the 2FA QR with a real phone on staging and complete a login.
7. Upgrade dependencies (Django 5.2 LTS, Next.js 15/16, `@sentry/nextjs` 11) on a branch and rerun every suite.
8. Fix the P2 UI error states and remove the static "+18.4 %"; either implement Inventory / Influencer or hide them behind the module flag (`platform_modules.is_active=false`).
9. Rerun this checklist on staging, then decide.
