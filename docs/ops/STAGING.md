# Staging deploy

Topology: `Next.js (Vercel or container)  ->  /api/* rewrite  ->  Django (gunicorn) behind TLS proxy  ->  Postgres 16 (+ Redis)`.
Staging must be a **separate** Postgres, Supabase project and set of third-party credentials from production
(Shopify dev store, Razorpay *test* keys, Meta test ad account, Delhivery staging host).

## 1. One-time provisioning
1. Postgres 16 database `commerce_intel_staging` + a least-privilege app role. Redis 7 (rate-limit counters, sessions).
2. A Supabase project for staging. Copy its **JWT secret** (Project Settings > API) - Django verifies tokens offline with it.
3. Generate secrets locally and store them in the platform secret manager (never in git):
   ```
   python -c "import secrets;print(secrets.token_urlsafe(64))"   # SECRET_KEY
   python -c "import secrets;print(secrets.token_urlsafe(48))"   # INTEGRATION_ENCRYPTION_KEY
   ```
4. DNS + TLS: `api-staging.<domain>` -> API proxy, `staging.<domain>` -> frontend. The proxy must set `X-Forwarded-Proto`.

## 2. Backend environment (see `backend/.env.example` for the full list)
```
DJANGO_SETTINGS_MODULE=config.settings.prod
SECRET_KEY=...                         INTEGRATION_ENCRYPTION_KEY=...
ALLOWED_HOSTS=api-staging.<domain>
CORS_ALLOWED_ORIGINS=https://staging.<domain>
CSRF_TRUSTED_ORIGINS=https://staging.<domain>
DATABASE_URL=postgres://app:***@db:5432/commerce_intel_staging     DB_SSLMODE=require
REDIS_URL=redis://redis:6379/0
SUPABASE_JWT_SECRET=...   SUPABASE_URL=https://<ref>.supabase.co   SUPABASE_ANON_KEY=...
DELHIVERY_BASE_URL=<delhivery staging host>
SENTRY_DSN=...  SENTRY_ENVIRONMENT=staging
DEMO_MODE=false
```
`config.settings.prod` refuses to start if `SECRET_KEY` is weak, `INTEGRATION_ENCRYPTION_KEY` is missing,
`ALLOWED_HOSTS` is `*`, or `DEMO_MODE` is on.

## 3. Deploy
```
cd backend
pip install -r requirements.txt
python manage.py check --deploy            # must show no security.W0xx warnings
python manage.py migrate --noinput
python manage.py collectstatic --noinput
gunicorn config.wsgi:application --bind 0.0.0.0:8000 --workers 3 --timeout 30 --access-logfile -
```
Frontend: set `BACKEND_URL=https://api-staging.<domain>`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
`NEXT_PUBLIC_SENTRY_DSN`, then `npm ci && npm run build && npm run start`.

## 4. Webhooks (staging only)
Register in the *test* consoles: `https://api-staging.<domain>/api/webhooks/shopify/<brand_uuid>/` and
`.../razorpay/<brand_uuid>/`; store the shared secrets via the integrations API
(`POST /api/w/<slug>/b/<brand>/integrations/` with `webhook_secret` / `api_secret`).

## 5. Smoke test (run after every deploy; blocks promotion on failure)
```
API_URL=https://api-staging.<domain> WEB_URL=https://staging.<domain> \
SMOKE_JWT=<staging test user's access token> \
SMOKE_WORKSPACE_SLUG=<their workspace> SMOKE_BRAND_ID=<their brand uuid> \
SMOKE_FOREIGN_SLUG=<a workspace they are NOT in> \
SMOKE_RAZORPAY_BRAND_ID=<brand uuid with Razorpay connected> \
python scripts/smoke_staging.py
```
It verifies HTTPS redirect + HSTS, DEBUG off, 401 for missing/malformed/`alg=none`/dev tokens, tenant isolation (foreign
slug and cross-workspace brand id are 404), the core read endpoints, unsigned/tampered Razorpay webhooks -> 401, and
that the frontend renders and proxies `/api`. Exit code 0 only if every check passes.

## 6. Rollback
Deploy artifacts are immutable images/tags: redeploy the previous tag. Migrations in this repo are forward-only; for a
bad migration restore the latest dump with `docs/ops/BACKUP_RESTORE.md` into a fresh DB and repoint `DATABASE_URL`.
