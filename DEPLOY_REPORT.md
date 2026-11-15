# Deployment review: 125 East Commerce Intelligence

Reviewed 2026-11-15 against the working tree at `C:\Users\aruun\OneDrive\Desktop\125east` (no commits exist yet; app code under `backend/apps/integrations/` was being edited during the review).

## 1. Verdict

**NO-GO.** Nine checks in the Critical sections 1-3 fail on evidence from the code alone, and no staging environment was supplied, so nothing that needs a live environment could be run.

## How to read this report

- The brief's placeholders (`<host>`, `<staging URL>`, region, domains, alert channel) were not filled in. There is no deployed environment, Dockerfile, image or CI pipeline in the repo.
- **PASS (local)** means the check was run on this machine with `config.settings.prod` against a throwaway Postgres 18 (the target is 16). It is evidence about the code, not about a deployed environment.
- **BLOCKED** means the check needs staging, cloud access or a tool that is not available. It was not run.
- Per the stop rule, once Critical checks failed in sections 1-3, sections 4-10 were limited to what the repo itself shows. No load tests, smoke journey or restore drill were attempted.
- No production or live merchant account was touched. No application code was changed.

## 2. Check table

### Section 1: Config and secrets (Critical)

| # | Check | Severity | Result | Evidence | Fix |
|---|---|---|---|---|---|
| 1.1 | `config.settings.prod`, `DEBUG=False`, 500 has no stack trace | Critical | PASS (local) | Forced a `RuntimeError` in a view: `500, len 145, leaks exception text: False, traceback: False`. `DEBUG=True` in the environment still yields `DEBUG = False`. `Bearer dev-mock-token` under prod settings returns 401. | Repeat on staging. |
| 1.2 | Required env vars present and non-default | Critical | FAIL | The code does not read `DJANGO_SECRET_KEY`, `FIELD_ENCRYPTION_KEY`, `MIGRATOR_DATABASE_URL`, `PUBLIC_API_URL`, or any email or S3 variable. It reads `SECRET_KEY` and `INTEGRATION_ENCRYPTION_KEY` (any string of 32+ chars, not a 32-byte base64 key). No `CELERY_*` setting exists, so the broker URL in `.env` is never used. Actual staging values: BLOCKED. | Agree one set of names; add the missing settings; make `REDIS_URL`, `SUPABASE_JWT_SECRET`, `SUPABASE_URL` and the Celery broker required in `prod.py`. |
| 1.3 | Boot fails loudly without `SECRET_KEY` or the encryption key | Critical | PASS (local) | `SECRET_KEY=""` -> `ImproperlyConfigured: SECRET_KEY env var must be set...`; `INTEGRATION_ENCRYPTION_KEY=""` -> `ImproperlyConfigured: INTEGRATION_ENCRYPTION_KEY must be set`. | None. See 1.5 for other silent fallbacks. |
| 1.4 | No secrets in repo, image layers, build logs, frontend bundle | Critical | FAIL | `supabase/migrations/20261110000001_extensions_and_roles.sql:15` creates `app_user` with a literal password (same literal pattern in `docs/database/PHASE_2_DATABASE_ARCHITECTURE.md:133` and `appflow/phases/02_...md:78`). `backend/apps/accounts/authentication.py:17-23` hard-codes a Supabase project URL and anon key as defaults. `.env` files are untracked (good). Frontend bundle: 0 hits for `sk_`, `rzp_`, `shpat_`; the `EAA` and `secret` hits are a GIF data URI and supabase-js doc comments. gitleaks is not installed (regex scan used instead); `docker history` BLOCKED (no Dockerfile or image). | Remove the password from SQL (set it out of band) and rotate it anywhere that migration has run. Remove the hard-coded Supabase defaults. Run gitleaks in CI. The repo has no commits yet, so fixing now leaves nothing in history. |
| 1.5 | Dev, staging and prod use different secrets, DBs, Redis, buckets | Critical | FAIL | Any environment missing `SUPABASE_URL` or `SUPABASE_JWT_SECRET` silently verifies tokens against the one hard-coded Supabase project. Every environment that runs the Supabase migration gets the same `app_user` password. Without `REDIS_URL`, prod settings silently use `LocMemCache` and DB sessions (`cache: LocMemCache`, `SESSION_ENGINE: ...db`). Actual environments: BLOCKED. | As 1.2 and 1.4. |
| 1.6 | `check --deploy` returns zero warnings | Medium | FAIL | `System check identified 64 issues`: 30 x `drf_spectacular.W001`, 34 x `drf_spectacular.W002`. No `security.W*` warnings. | Add serializers/`@extend_schema`, or silence those two IDs explicitly so new security warnings stay visible. |

### Section 2: Database and RLS (Critical)

| # | Check | Severity | Result | Evidence | Fix |
|---|---|---|---|---|---|
| 2.1 | Migrations run only as `migrator`; nothing pending; no drift | Critical | FAIL | No `DJANGO_DB_ROLE` or `MIGRATOR_DATABASE_URL` support anywhere in `backend/` (grep). One `DATABASE_URL` serves web, workers and migrations. Locally: `migrate --check` exit 0; `makemigrations --check --dry-run` -> `No changes detected`. | Add a migrator connection and a deploy step that uses it. |
| 2.2 | Web and workers connect as `app_user` | Critical | BLOCKED | No running containers. `docs/ops/STAGING.md` describes a "least-privilege app role" but the code has no role separation. | Run `SELECT current_user;` in each container on staging. |
| 2.3 | `app_user` has no BYPASSRLS, no superuser, owns no tables, no CREATE | Critical | BLOCKED | Cannot query a deployed database. The Supabase migration creates it `NOBYPASSRLS` with table DML grants only. | Query `pg_roles` and table ownership on staging. |
| 2.4 | Every `workspace_id` table has RLS enabled and forced | Critical | FAIL | Database built by `manage.py migrate`: 18 of 18 `workspace_id` tables have `relrowsecurity=f, relforcerowsecurity=f`; `pg_policies` count is 0. The separate Supabase SQL migrations do enable RLS (27 statements) but contain 0 `FORCE ROW LEVEL SECURITY`. | Pick one schema source. Enable and force RLS in it for every tenant table. |
| 2.5 | `app_user` with no `app.workspace_id` sees 0 rows | Critical | FAIL | On the Django-migrated database there is no RLS, so every row is visible. The app also never sets the context: `RLSMiddleware` is not in `MIDDLEWARE`, and it runs `SET LOCAL` outside a transaction (`ATOMIC_REQUESTS` is not set), which has no effect. If RLS were enforced for `app_user` today, the API would return nothing. | Wrap requests in a transaction and set the context there; add a test that fails when it is missing. |
| 2.6 | PgBouncer in transaction mode, no context leak | High | BLOCKED | No pooler to test. `DB_POOLER_TRANSACTION_MODE` exists as a setting. | Test on staging after 2.5 is fixed. |
| 2.7 | Postgres not public, TLS required, backups + PITR >= 7 days | Critical | BLOCKED | No database host supplied. `DB_SSLMODE` is optional and not enforced by `prod.py`. | Require `sslmode=require` in `prod.py`; verify the rest on the host. |
| 2.8 | Restore drill with RTO and RPO | High | BLOCKED | No staging backup. `docs/ops/BACKUP_RESTORE.md` records an earlier drill; I did not re-run or verify it. | Run `scripts/pg_restore_verify.sh` against a staging dump and record timings. |

### Section 3: Network, TLS, headers (Critical for go/no-go)

| # | Check | Severity | Result | Evidence | Fix |
|---|---|---|---|---|---|
| 3.1 | HTTP redirects to HTTPS; TLS 1.2+; valid cert | High | PASS (local) for redirect; BLOCKED for TLS | Plain HTTP -> `301 https://api.example.test/api/auth/csrf/`. No host for `curl -vI` or testssl. | Run testssl/SSL Labs on staging. |
| 3.2 | API security headers | High | FAIL | Present: `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`. Missing: `Content-Security-Policy: null`, `Cache-Control: null` on `/api/`. | Add a CSP and `Cache-Control: no-store` for `/api/`. |
| 3.3 | Frontend CSP without `unsafe-eval`, `frame-ancestors none` | High | FAIL | `frontend/next.config.mjs` defines no `headers()`; no CSP anywhere in the frontend. | Add `headers()` with a CSP and `frame-ancestors 'none'`. |
| 3.4 | Cookie flags and domain | High | PASS (local) for flags; BLOCKED for domain | `csrftoken`: `secure: True, samesite: Lax`. Settings: `SESSION_COOKIE_SECURE=True`, `HTTPONLY=True`, `SAMESITE=Lax`. Cookie domain is unset (host-only); `.env` has `SESSION_COOKIE_DOMAIN` but the code never reads it. | Verify on the real `app.` and `api.` domains. |
| 3.5 | CORS rejects foreign origins | High | PASS (local) | `Origin: https://evil.com` -> no `Access-Control-Allow-Origin` (GET and preflight). Allowed origin -> echoed with `Allow-Credentials: true`. | Repeat on staging. |
| 3.6 | `/api/schema/` and admin/debug routes return 404 in prod | High | FAIL | Under prod settings: `/api/schema/ -> 200`, `/api/docs/ -> 200`, `/admin/login/ -> 200`. | Gate schema, docs and admin behind a setting that is off in prod (or an IP allowlist for admin). |
| 3.7 | Redis not public, password/TLS | High | BLOCKED | No Redis host supplied. | Test from outside the VPC. |
| 3.8 | S3 bucket private, 15-minute presigned URLs, tenant isolation | High | BLOCKED | Nothing to test: there is no S3, export or presign code in `backend/` (grep for `boto3`, `presigned`, `csv`). | Build the export feature, then test. |

### Sections 4-10 (static evidence only; live checks not attempted)

| # | Check | Severity | Result | Evidence | Fix |
|---|---|---|---|---|---|
| 4.1 | Full user journey smoke test | High | BLOCKED | No staging. Several steps cannot pass yet: there is no email verification and no CSV export in the code. `scripts/smoke_staging.py` covers a narrower set (redirect, auth rejection, tenant isolation, Razorpay signature). | Supply staging; extend the smoke script to the full journey. |
| 4.2 | `GET /api/health/` = 200 under 300 ms | High | FAIL | `/api/health/ -> 404`, `/api/health -> 404`, `/healthz -> 404`. Only `/` returns a static "healthy" JSON with no dependency checks. | Add a health endpoint that checks DB and Redis. |
| 5.1-5.4 | Webhooks reachable, bad signature 401, replay, worker-down survival | High | BLOCKED | No public URL. The webhook code was rewritten during this review (`webhook_views.py`, enqueue via `transaction.on_commit`); `tests/security/test_webhooks.py` has not been re-run against it, and 6 older webhook tests now fail with 401 on valid signatures. | Re-run both webhook suites, then test from provider dashboards. |
| 5.5 | Shopify compliance webhooks | Low (High if public app) | FAIL | No handler for `customers/data_request`, `customers/redact`, `shop/redact` (grep). | Implement before listing as a public app. |
| 6.1-6.5 | Queues, single beat, `acks_late`, retries, schedules, backlog alert | High | FAIL | No `CELERY_*` settings in `config/settings/` (so no Redis broker is configured), no beat schedule, no queue routing, no `acks_late` (grep). `process_webhook_event_task` has retries with backoff, but no failure log or dead letter. Live behaviour: BLOCKED. | Add broker, queues, beat schedule and `acks_late`; then test on staging. |
| 7.1 | Load test p50/p95/p99 | High | BLOCKED | No staging; k6 and Locust are not installed. | Run on staging. |
| 7.2 | No N+1 on list endpoints | Medium | PASS (local) | `tests/test_rate_limit_and_queries.py::TestNoNPlusOne` passes (query count identical at 5 and 65 rows across 8 endpoints). | None. |
| 7.3 | 6 bad logins/min = 429 | High | FAIL | Shipped rate is `auth: 10/min`; `tests/test_auth.py` shows the 6th attempt returns 400. `NUM_PROXIES` is unset, so behind a proxy the throttle key comes from client-supplied `X-Forwarded-For`. Without Redis the counters are per-process. | Set `THROTTLE_AUTH=5/min`, `NUM_PROXIES`, and require Redis. |
| 7.4 | Gunicorn workers vs `max_connections` | Medium | BLOCKED | No database to read `max_connections` from. Docs suggest 3 workers. | Check on the host. |
| 7.5 | Plan limits enforced server-side | High | FAIL | `tests/test_org_control.py::TestPlanLimits`: a starter workspace creates a 2nd brand (201), a 4th member and a 3rd integration. | Enforce limits in the API. |
| 8.1 | Sentry receives test errors, PII scrubbed | Medium | BLOCKED | No DSN or project. Code sets `send_default_pii=False` (backend) and `sendDefaultPii: false` (frontend). | Send a test event from web and worker on staging. |
| 8.2 | Structured logs, shipped, no PII | Medium | BLOCKED | JSON logging is configured; no log sink to sample. | Grep a staging sample. |
| 8.3-8.4 | Uptime monitor and alerts | Medium | BLOCKED | Nothing in the repo defines monitors or alerts; no channel was named. | Set up and list them. |
| 9.1 | Privacy policy and terms linked at signup | High | FAIL | No privacy or terms route under `frontend/src/app/`; no match for "privacy" or "terms" in `frontend/src`. | Publish and link both. |
| 9.2 | Workspace deletion purges all tenant data | High | BLOCKED | Needs staging row counts. In code, every workspace/brand foreign key is `CASCADE`; there are no S3 exports to purge. | Prove with before/after counts on staging. |
| 9.3 | Credentials stored as encrypted bytes | High | BLOCKED | Raw inspection needs a deployed database. Code stores AES-256-GCM ciphertext in a `BinaryField` (`apps/integrations/crypto.py`). | Inspect `integrations_integration` on staging. |
| 9.4 | Data residency documented | Medium | FAIL | No privacy policy exists to document it (9.1). | Document the region in the policy. |
| 10.1 | Previous image kept; rollback tested | High | BLOCKED | No image or Dockerfile. `docs/ops/STAGING.md` section 6 describes rollback; it has not been tested. | Build images; rehearse N -> N-1 on staging. |
| 10.2 | Migrations backward compatible with N-1 | Medium | BLOCKED | No previous release to compare with. | Review per release. |
| 10.3 | Zero-downtime deploy | Medium | BLOCKED | No environment. | Run a curl loop during a staging deploy. |
| 10.4 | CI gates the deploy | High | FAIL | No CI configuration in the repo (no `.github`, GitLab or other). `bandit`, `pip-audit` and gitleaks are not installed. `backend/requirements.txt` has 0 pinned versions. The test suite itself is red (see below). | Add CI with tests, `tests/security`, bandit, pip-audit, npm audit, `check --deploy`; pin dependencies. |

## 3. Blockers

Critical or High checks that failed:

1. **1.2** Required environment variables are not what the code reads; Redis, Supabase and the Celery broker have no prod-time requirement.
2. **1.4** A database role password is a literal in a tracked SQL migration; a Supabase project URL and key are hard-coded in auth code.
3. **1.5** Environments are not forced apart: missing variables fall back to one shared Supabase project and an in-process cache.
4. **2.1** No separate migrator role or connection.
5. **2.4** RLS is not enabled on any table when the schema is built by Django migrations, and is not forced anywhere.
6. **2.5** The application never sets `app.workspace_id`, so the database half of the dual lock does not work.
7. **3.2** No CSP and no `Cache-Control: no-store` on the API.
8. **3.3** No CSP or `frame-ancestors` on the frontend.
9. **3.6** `/api/schema/`, `/api/docs/` and `/admin/` are served under prod settings.
10. **4.2** No health endpoint.
11. **6.x** Celery has no broker, queue, schedule or `acks_late` configuration.
12. **7.3** Login throttle is 10/min and can be bypassed through `X-Forwarded-For`.
13. **7.5** Plan limits are not enforced.
14. **9.1** No privacy policy or terms.
15. **10.4** No CI; dependencies unpinned.

Also open from the security test work in `docs/TEST_CHANGES.md` (all High): user enumeration on register, no email verification, TOTP replay, no CSRF on login/register/MFA challenge, no MFA gate for owners and admins, invites accepted by the wrong email, brand leaks in two list endpoints, cancelled orders counted in metrics. Current test status: `test_auth.py` 16 failing, `test_org_control.py` 64 failing, `test_metrics.py` 42 failing, plus 7 failures in the older suite.

## 4. Measured numbers

| Metric | Value |
|---|---|
| RTO | Not measured (no staging backup to restore) |
| RPO | Not measured; `docs/ops/BACKUP_RESTORE.md` states 24h with daily dumps |
| Metrics p95 | Not measured (no load test run) |
| Webhook p95 | Not measured |
| Error rate | Not measured |
| `/api/health/` latency | Not applicable; the endpoint returns 404 |

## 5. Commands to re-run

Local checks (need a scratch Postgres; replace the URL):

```bash
cd backend
export DJANGO_SETTINGS_MODULE=config.settings.prod \
  SECRET_KEY="$(python -c 'import secrets;print(secrets.token_urlsafe(64))')" \
  INTEGRATION_ENCRYPTION_KEY="$(python -c 'import secrets;print(secrets.token_urlsafe(48))')" \
  ALLOWED_HOSTS=api.example.test CORS_ALLOWED_ORIGINS=https://app.example.test \
  DATABASE_URL=postgres://<user>:<pw>@127.0.0.1:5432/deploycheck \
  DEMO_MODE=False REDIS_URL="" SENTRY_DSN="" SUPABASE_JWT_SECRET=<any 32+ chars> LOG_PLAIN=True

# 1.6
python manage.py check --deploy
# 1.3
SECRET_KEY="" python manage.py check
INTEGRATION_ENCRYPTION_KEY="" python manage.py check
# 2.1
python manage.py migrate && python manage.py migrate --check && python manage.py makemigrations --check --dry-run
# 1.1, 3.1-3.6, 4.2
PYTHONPATH="$PWD" python ../scripts/deploy_review/probe.py
```

RLS state (2.4, 2.5), against any database:

```sql
SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname !~ '^pg_';
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, pg_get_userbyid(c.relowner)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN information_schema.columns col
  ON col.table_schema = n.nspname AND col.table_name = c.relname AND col.column_name = 'workspace_id'
WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY 1;
SELECT count(*) FROM pg_policies;
```

Secrets and bundle (1.4):

```bash
gitleaks detect --no-git --source .          # install first; a regex scan was used in this review
grep -rIlE "sk_(live|test)_|rzp_(live|test)_[A-Za-z0-9]{6,}|shpat_[a-f0-9]{8,}|EAA[A-Za-z0-9]{20,}" frontend/.next/static
```

Test suites (need Postgres):

```bash
cd backend && DATABASE_URL=postgres://<user>:<pw>@localhost:5432/commerce_intel pytest tests
```

Once staging exists:

```bash
API_URL=https://<api-staging> WEB_URL=https://<staging> SMOKE_JWT=... python scripts/smoke_staging.py
curl -vI http://<api-staging>/ ; testssl.sh <api-staging>
scripts/pg_restore_verify.sh <dump> <source-url> <admin-url>
```
