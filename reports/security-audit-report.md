# Security & Vulnerability Audit (Phase 14)

*2026-11-21. Defensive review: source reading, automated tests, read-only inspection of the hosted database and Supabase Auth settings, dependency advisories (npm audit, OSV). No destructive or exploit traffic was sent to production or to third-party systems; exploitability was demonstrated only on isolated replicas.*

## 1. Findings

| ID | Sev | Finding | Status |
|---|---|---|---|
| **P0-1** | Critical | **2FA bypass**: uncommitted frontend logged in with `supabase.auth.signInWithPassword`, never asked for the TOTP code (and left fresh browsers unable to reach the dashboard) | **Fixed** (Django session + TOTP restored); browser-retested |
| **P0-4** | Critical | **Self-service super-admin / 2FA-disable on the hosted DB**: open sign-ups with auto-confirm + `authenticated` holding table UPDATE on `accounts_user` (migration `…000011` never applied) → any internet user can set its own `is_superuser` / `mfa_enabled`, insert recovery codes, read `password` hash / `mfa_secret` / `encrypted_credentials` | **Fix written, NOT deployed** (`20261121150100`); reproduced and fixed on a replica |
| P1-5 | High | Re-running 2FA setup while enabled overwrote the confirmed secret with a new one returned to the caller; the login challenge preferred it → a stolen session could take over the second factor | **Fixed** (409 until disabled; challenge uses only the confirmed secret) |
| P1-6 | High | TOTP secret written in plaintext to `accounts_user.mfa_secret` on confirm | **Fixed** (encrypted only). Hosted DB has 0 such rows |
| P1-11 | High | 2FA brute force: IP throttle keyed on client-controlled `X-Forwarded-For` (DRF `NUM_PROXIES=None`); unlimited fresh challenges | **Fixed** (per-account lockout, 10 / 15 min) + `DRF_NUM_PROXIES` setting added (set it in prod) |
| P1-20 | High | Production path = Vercel → **Cloudflare quick tunnel** → developer-machine Django using `config.settings.dev`: `DEBUG=True` (stack traces + settings on errors), `ALLOWED_HOSTS` incl. `*`, no `Secure` cookie flag, no HSTS, connected to the production DB | **Open** (infrastructure) |
| P1-21 | High | API proxy re-sent requests (cookies + body) to a hardcoded second backend on 5xx/network errors, including POSTs → replayed logins/payments/syncs and possible traffic leak to an unintended host | **Fixed** (fallback only for GET/HEAD/OPTIONS; `DISABLE_BACKEND_FALLBACK`) |
| P1-12 | High | Super-admin console (service-role powers over all tenants) accepts a single-factor Supabase JWT; no `aal2` check | **Open** |
| P2-17 | Medium | `SECURITY DEFINER` `get_user_effective_modules` / `is_super_admin` callable by `anon` for arbitrary user ids | **Fixed in migration** `20261121150000` (not deployed) |
| P2-22 | Medium | Module-permission tables created without RLS in the migration (hosted DB protected only by the `ensure_rls` event trigger) | **Fixed in migration** `20261121150000` |
| P2-23 | Medium | Django DB role `app_user` has `BYPASSRLS`, so RLS is not a second line of defence on the Django path | **Open** (isolation verified at the app layer: 261 tenancy tests pass) |
| P2-14 | Medium | No per-account lockout for **password** guessing | **Open** |
| P2-24 | Medium | Supabase Auth: `minimum_password_length = 6`, no complexity, email confirmations off (repo `config.toml`; hosted `mailer_autoconfirm: true`) | **Open** |
| P2-25 | Medium | `EMAIL_BACKEND` defaults to the console backend, so password-reset links (live tokens) are written to the server log if production keeps the default | **Open**: set SMTP in production |
| P2-26 | Medium | Dependencies: **Next.js 14.2.35, 1 critical + several high advisories** (fix only in 16.x); `postcss` (high, via next); `rollup` and `@sentry/nextjs` (high, fix in `@sentry/nextjs` 11.x); 27 moderate (OpenTelemetry chain). **Django 5.1.15** (5.1 is past end of support): 6 advisories; **DRF 3.17.2**: 3 advisories | **Open**: plan upgrades (Django 5.2 LTS, Next 15/16, Sentry 11) with regression runs |
| P3-16 | Low | Edge `wrapHandler` returned raw exception text on 500 | **Fixed** |
| P3-27 | Low | Proxy returned upstream error `details` (`err.message`) to clients; super-admin routes return `error.message` from Supabase | proxy **fixed**; super-admin routes open |
| P3-28 | Low | `/api/docs` and `/api/schema` (Swagger/OpenAPI) publicly reachable | Open |
| P3-29 | Low | MFA challenge token carried in the URL query string | Open (short-lived, single-use, useless without TOTP) |
| P3-30 | Low | `/dev/tests` (connection-test console) was public in middleware | **Fixed** (now requires a session) |
| P3-31 | Low | Middleware treated any `sb-*-auth-token` cookie as a session (forged cookie served protected page shells) | **Fixed** (Django cookie only; APIs were always protected) |

## 2. Checklist

| Area | Result |
|---|---|
| Broken access control / IDOR / cross-workspace leakage | App layer: **pass** (Django 261 tenancy tests; Edge 403/404 tests). Hosted DB: **fail** until P0-4 is deployed |
| Authentication bypass | P0-1 fixed; P0-4 open on the hosted DB |
| 2FA bypass | app: pass; hosted DB: fail (P0-4) |
| Session fixation / handling | pass (`cycle_key`, HttpOnly, SameSite=Lax, server-side invalidation). `Secure` only in prod settings (P1-20) |
| CSRF | pass (DRF + explicit CSRF for pre-auth endpoints; e2e `FE-RTE-08`) |
| XSS | no `dangerouslySetInnerHTML` with user data found in `frontend/src` (React escaping); Django returns JSON only |
| SQL injection | ORM / parameterised queries only; one `cursor.execute("SET LOCAL app.workspace_id = %s")` parameterised; PGlite helper validates identifiers |
| Command injection | no shell execution in request paths |
| SSRF | Edge: Shopify domain validated (`*.myshopify.com`), pagination restricted to the provider host (tests); Django: provider base URLs fixed |
| Rate limits | auth / sync / ndr scopes exist; XFF caveat (P1-11 mitigated, P2-14 open); Edge functions rely on platform limits |
| Weak password validation | Django: strong. Supabase Auth: weak (P2-24) |
| Exposed env vars / credentials | service-role key absent from the client bundle ✓; anon key in the bundle (public by design); `.env` files git-ignored ✓; `backups/` git-ignored ✓ |
| CORS | Django: explicit allow-list with credentials; Edge: `*` without cookies (acceptable) |
| Cookie attributes | see session handling |
| Sensitive data in logs | Edge logger redacts tokens (tested); Django logs ids only; reset emails to console (P2-25) |
| File uploads | none present |
| Webhook signature bypass / replay | pass: raw-byte HMAC, constant-time compare, empty-secret rejection, dedupe, size limit |
| Excessive DB permissions | `app_user` BYPASSRLS (P2-23); `authenticated` over-granted on the hosted DB (P0-4) |

## 3. Commands used

- `cd frontend && npm audit --omit=dev --json`
- OSV batch query of `pip list --format=freeze` (backend venv, 90 packages): `POST https://api.osv.dev/v1/querybatch` (package names and versions only)
- Hosted catalog (read-only, as `app_user`): `pg_class`, `pg_policies`, `aclexplode(relacl)`, `has_column_privilege`, `pg_proc`, `pg_roles`, `_schema_migrations`
- Hosted Supabase Auth: `GET /auth/v1/settings` (public, read-only)
- Client bundle secret scan: compared configured secret values against `frontend/.next/static/**` (match/no-match only)
