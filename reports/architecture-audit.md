# 125East — Architecture Audit

*Audit date: 2026-11-21 · Scope: the working tree at `main` @ `dfe480a` plus uncommitted changes · Method: source reading, read-only catalog queries against the hosted database, local test execution*

## 1. What the system actually is

125East is a **hybrid** of three backends. The README still describes only the first one.

| Layer | Technology | Location | Status in the working tree |
|---|---|---|---|
| Frontend | Next.js 14.2 (App Router), React 18, Tailwind | `frontend/` | Active. 35 pages, 15 Next route handlers |
| API proxy | Next route handler `app/api/[[...path]]/route.ts` | `frontend/src/app/api/` | Forwards `/api/*` to Django (`BACKEND_URL`, else a hardcoded Cloudflare quick-tunnel) |
| Primary API ("monolith") | Django 5.1 + DRF, server-side sessions, Celery (eager), TOTP 2FA | `backend/` | Active. Serves auth, 2FA, tenancy, dashboards, Django webhooks |
| Serverless | Supabase Edge Functions (Deno), 7 functions | `serverless/supabase/functions/` | Active for sync, connection tests and serverless webhooks; called directly from the browser |
| Super-admin API | Next route handlers using the Supabase **service-role** key | `frontend/src/app/api/super-admin/*` | New (uncommitted). Requires a Supabase JWT plus `is_superuser` |
| Database | Supabase Postgres 17 (`ybyroxyofqfpozvfedhc`, ap-south-1) | `supabase/migrations/` (18 files) plus Django migrations | Shared by Django (role `app_user`), the Edge Functions (service role) and the browser (anon/authenticated via PostgREST) |
| Auth | **Two user stores**: Django `accounts_user` (password hash, TOTP) **and** Supabase `auth.users` (provisioned into `accounts_user` by the `handle_new_auth_user` trigger) | — | See §4: the source of truth was split in the working tree |

### Deployment topology (as configured)

```
Browser ──► Vercel (Next.js)  ──/api/*──►  route.ts proxy ──► BACKEND_URL or https://<quick-tunnel>.trycloudflare.com
                                                                 └► developer machine: Django runserver, backend/.env (DEBUG=True)
                                                                      └► Supabase Postgres (production DB, role app_user, BYPASSRLS)
Browser ──► Supabase Edge Functions (NEXT_PUBLIC_FUNCTIONS_URL, currently a LAN IP 192.168.1.12:54321)
Browser ──► Supabase PostgREST (anon key, RLS enforced)
```

Observed on 2026-11-21:
- Both hardcoded quick-tunnel hostnames (`motion-islamic-starting-window…`, `appropriations-aluminum-martial-guitar…`) fail DNS resolution: the tunnels are gone.
- `https://125east-dashboard.vercel.app` returns `DEPLOYMENT_NOT_FOUND`.
- So **no reachable staging or production deployment exists right now**.

## 2. Request flows (traced in code)

### 2.1 Login + 2FA (Django; restored as the source of truth, see §4)
`/login` → `AuthContext.login` → `POST /api/auth/login/` (CSRF) → `LoginView`:
- **2FA on:** returns `{mfa_required, challenge_token}` and creates **no session** → `/mfa-challenge` → `POST /api/v1/auth/mfa/verify/` → `MFAChallengeView` checks the TOTP (±1 step, anti-replay) or a recovery code → `start_session(mfa_verified=True)`.
- **2FA off:** `start_session()` immediately.
Session = HTTP-only `sessionid` cookie in the `django_session` table, 7-day absolute expiry, `cycle_key()` on login.

### 2.2 Dashboard data
Page → `apiFetch('/api/w/<slug>/b/<brand>/…')` → Next proxy → Django `TenancyMiddleware` (slug → membership → `request.tenant`) → permission classes (`HasTenantAccess`, `IsWorkspaceAdmin`) → ORM query filtered by `workspace` + `brand` → JSON. The `get_cached_tenant_data` LocMem cache is keyed by tenant.

### 2.3 Integration sync (serverless)
`/integrations` → `invokeEdgeFunction('shopify-sync', {workspace_id, brand_id})` with a **Supabase JWT** → `requireAuth` (`auth.getUser`) → `requireWorkspaceAccess` (RLS-scoped membership read) → `requireModuleAccess` (`get_user_effective_modules` RPC) → `loadIntegration` (service role, decrypts AES-256-GCM credentials) → `fetchWithRetry` to the provider (timeouts, 429 Retry-After, same-host pagination) → `mapShopify*` normalisers → idempotent upserts → `integrations_syncrun` row.
**Gap:** after the auth restore the main app holds a Django session, not a Supabase JWT, so browser-invoked Edge Functions are only usable with a separate Supabase session (see the defect register).

### 2.4 Webhooks
Two independent implementations write to the same tables:
- Django: `POST /api/webhooks/{shopify|razorpay|meta|shiprocket|delhivery}/<brand_uuid>/` → HMAC over raw bytes → `WebhookEvent.get_or_create(event_id)` → `on_commit` → Celery task → `ingest_*`.
- Edge Functions: `webhook-shopify|webhook-razorpay?brand_id=<uuid>` → the shared `handleWebhook` pipeline (size limit → signature → duplicate check → process → event log).

## 3. Feature map

| Feature | Frontend entry | API | Processing | Tables | AuthN | AuthZ | External | Existing tests |
|---|---|---|---|---|---|---|---|---|
| Register / login / logout | `/register`, `/login` | `/api/auth/{register,login,logout,me,csrf}` | `accounts.views` | `accounts_user`, `django_session`, `tenancy_*` | session + CSRF | — | HIBP (k-anon) | `test_auth*.py`, `test_session_auth.py`, e2e `01`, `07` |
| Password reset | `/forgot-password`, `/reset-password` | `/api/auth/password-reset[/confirm]` | Django token generator | `accounts_user` | CSRF | — | SMTP (console backend by default) | `test_auth.py` |
| Google Authenticator 2FA | `/settings`, `/mfa-setup`, `/mfa-challenge` | `/api/{auth,v1/security}/mfa/*` | `accounts.services` (pyotp, Fernet) | `accounts_usermfa`, `accounts_mfachallenge`, `accounts_mfarecoverycode` | session | self | — | `test_totp_mfa.py`, `test_auth_and_mfa.py`, **new** `test_mfa_hardening.py`, e2e `05` |
| Workspaces / brands / members / invites | shell dropdowns, `/team`, `/invites/accept` | `/api/w/…` | `tenancy.views` | `tenancy_*` | session | role (owner/admin/analyst/viewer) | — | `test_tenancy_isolation.py`, `test_cross_tenant.py`, `test_invites_and_rbac.py` |
| Shopify dashboard | `/shopify`, `/` | `…/shopify/{stats,intelligence,sync-now}` | `integrations.views`, `shopify/sync.py` | `commerce_order*`, `commerce_customer` | session | tenant + brand | Shopify Admin REST 2024-10 | `test_shopify_dashboard.py`, `test_metrics.py` |
| Payments (Razorpay) | `/payments` | `…/payments/{stats,transactions}` | `payments_views` | `commerce_paymentattempt` | session | tenant | Razorpay v1 | `test_phase3_connectors.py` |
| Marketing (Meta Ads, Instagram) | `/marketing` | `…/marketing/{stats,sync-now}` | `meta_ads/sync.py` | `analytics_factadsdaily` | session | tenant | Graph API v21 | `test_meta_ads_api.py` |
| Logistics | `/logistics` | `…/logistics/*` | `logistics_views` | `commerce_shipment`, `commerce_trackingevent` | session | tenant | Delhivery | `test_ndr_action.py` |
| Metrics / P&L | `/pnl`, `/` | `…/metrics/` | `analytics.views`, `catalogue.py` | the above + `analytics_*` | session | tenant | — | `test_metrics.py`, `test_analytics_metrics.py` |
| Integrations (connect, test, sync) | `/integrations`, `/dev/tests` | Django `…/integrations/` + Edge Functions | `test-connection`, `*-sync` | `integrations_integration`, `integrations_syncrun` | session + Supabase JWT | owner/admin + module | all four providers | `serverless/tests/db/*` |
| Super-admin console | `/super-admin/*` | `/api/super-admin/*` (Next) | service-role queries | all, plus `admin_audit_logs`, `*_module_permissions` | Supabase JWT | `is_superuser` (server-checked) | — | none (`docs/super-admin-test-report.md` is descriptive) |
| **Inventory** | `/inventory` | **none** | **none** | **none** | — | module flag only | — | none |
| **Influencer / UTM attribution** | `/influencer` | **none** | **none** | **none** | — | module flag only | — | none |

## 4. Key architectural findings

1. **Split-brain authentication (P0, fixed).** Uncommitted changes replaced the Django session login with `supabase.auth.signInWithPassword`. That (a) never asked for the Google Authenticator code, and (b) stored the session in `localStorage`, while middleware and every dashboard page rely on the Django `sessionid` cookie, so a fresh browser bounced back to `/login` after a "successful" sign-in. Verified in a browser (see `e2e-test-report.md`). After the owner's decision, the Django session + TOTP flow was restored in `AuthContext`, the middleware and the proxy. The new super-admin/module fields were kept.
2. **Production served from a developer machine (P1, open).** `vercel.json` and `route.ts` hardcode Cloudflare *quick* tunnels (ephemeral, no SLA) to a `runserver` using `config.settings.dev` with `DEBUG=True`, `ALLOWED_HOSTS` including `*`, connected to the production database. Both tunnels are dead today.
3. **Django bypasses RLS (P2, open).** Role `app_user` has `BYPASSRLS`, so on the Django path tenant isolation rests only on application code. Django's tests show that code isolates correctly, but RLS adds no defence in depth there.
4. **Two webhook implementations** (Django and Edge) for the same providers and tables, with different idempotency keys (`shopify:<brand>:<delivery>` vs `shopify:<delivery>`). If both endpoints are registered with a provider, events are processed twice under different keys. Upserts keep the business rows single, but the event log doubles.
5. **Celery app never loaded (P0, fixed).** `backend/config/__init__.py` was missing, so `@shared_task` bound to Celery's unconfigured default app and every Django webhook's processing tried to reach an AMQP broker.
6. **Inventory and influencer/UTM attribution do not exist** beyond static pages that displayed invented numbers (now replaced with an explicit empty state).
7. **Scheduled jobs:** none. There is no cron, `pg_cron` job or Vercel cron; syncs are manual (`sync-now` / Edge Function invocation). Celery runs in-process (eager) with no beat.
8. **Monitoring:** Sentry SDKs are wired but inert unless `SENTRY_DSN` is set. Logging is JSON to stdout (Django) and a redacting logger (Edge).

## 5. Environment variables (names only)

| Component | Variables |
|---|---|
| Django (`backend/.env`) | `DJANGO_SETTINGS_MODULE`, `DEBUG`, `SECRET_KEY`, `INTEGRATION_ENCRYPTION_KEY`, `MFA_ENCRYPTION_KEY` (optional; falls back to a key derived from `SECRET_KEY`), `ALLOWED_HOSTS`, `DEMO_MODE`, `DATABASE_URL`, `DB_SSLMODE`, `DB_CONN_MAX_AGE`, `DB_POOLER_TRANSACTION_MODE`, `FRONTEND_URL`, `CORS_ALLOWED_ORIGINS`, `CSRF_TRUSTED_ORIGINS`, `SESSION_COOKIE_AGE`, `THROTTLE_AUTH`, `THROTTLE_SYNC`, `THROTTLE_NDR`, **`DRF_NUM_PROXIES` (new)**, `EMAIL_*`, `DEFAULT_FROM_EMAIL`, `SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `SENTRY_TRACES_SAMPLE_RATE`, `LOG_LEVEL`, `LOG_PLAIN`, `SECURE_SSL_REDIRECT` |
| Next.js (`frontend/.env.local`, Vercel) | `NEXT_PUBLIC_SITE_URL`, `BACKEND_URL`, `NEXT_PUBLIC_BACKEND_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_FUNCTIONS_URL`, `SUPABASE_SERVICE_ROLE_KEY` (server only), `SESSION_COOKIE_NAME`, `ENABLE_BACKEND_REWRITES`, **`DISABLE_BACKEND_FALLBACK` (new)**, `SENTRY_*`, `NEXT_EXPORT`, `NEXT_OUTPUT_STANDALONE` |
| Edge Functions (`serverless/.env`, Supabase secrets) | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `INTEGRATION_ENCRYPTION_KEY`, `SECRET_KEY` (legacy decrypt fallback), optional provider defaults `SHOPIFY_*`, `RAZORPAY_*`, `META_*`, `INSTAGRAM_*` (all empty today) |
| Supabase Auth (`supabase/.env`) | `SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID`, `SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET`, `SITE_URL`, `ADDITIONAL_REDIRECT_URLS` |

The Supabase **anon** key and project URL are hardcoded as fallbacks in `supabaseClient.ts`, `serverless.ts` and `_shared/supabase.ts`. Anon keys are public by design, so this is not a secret leak, but the project ref is baked into every build.
