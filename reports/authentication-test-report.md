# Authentication & Session Test Report (Phase 3)

*2026-11-21. Environments: Django test suite (SQLite); isolated full stack (Next production build on :3100 → Django copy on :8011, SQLite, synthetic users, Supabase fully mocked); one browser probe against the owner's dev server with all Supabase and `/api` traffic intercepted.*

## 0. Headline

At the start of the audit, the **uncommitted working tree had replaced the Django session login with Supabase Auth**. Browser evidence (Supabase intercepted):

| Check | Result (before fix) |
|---|---|
| Password login for an account with 2FA enrolled | accepted, **no authenticator prompt** |
| Session storage | `localStorage` only, **0 cookies** |
| `/dashboard` right after "successful" login | **redirected back to `/login`** (middleware wants a cookie; every dashboard API wants the Django session) |
| Forged `sb-x-auth-token` cookie | middleware served protected page HTML |

**Defect P0-1 (2FA bypass + broken login).** With the owner's approval, the Django session + Google Authenticator flow was restored:
- `frontend/src/context/AuthContext.tsx`: committed version, plus the new `isSuperAdmin` / `modules` / `hasModule` fields.
- `frontend/src/middleware.ts`: Django cookie only; `/dev/` no longer public.
- `frontend/src/app/api/[[...path]]/route.ts`: removed the hard-coded `auth/me → 401` short-circuit.
- `backend/apps/accounts/serializers.py`: read-only `is_superuser` on `/me`.

All results below are **after** the fix unless stated.

## 1. Lifecycle results

| # | Test | Result | Evidence |
|---|---|---|---|
| 1 | New user registration | PASS | e2e `01-auth` "register → loading → /dashboard … survives refresh"; `test_auth.py` |
| 2 | Email validation | PASS | client-side + server `EmailField`; e2e "client-side validation…" |
| 3 | Password validation (min 10, common, numeric, similarity, HIBP k-anon) | PASS | `test_auth_and_mfa.py::test_user_registration_requires_10_char_password`, `test_auth.py` |
| 4 | Duplicate registration | PASS | e2e "duplicate email shows the server error…"; `DuplicateEmailError` race-safe path |
| 5 | Login, valid credentials | PASS | e2e "valid login … lands on /dashboard" |
| 6–7 | Invalid credentials / wrong password | PASS: same message for unknown email and wrong password (no enumeration) | e2e "wrong password and unknown email show the same error" |
| 8 | Logout | PASS: server row deleted; replaying the old `sessionid` → **401** | curl on the isolated stack: me 200 → logout 200 → me 401 → replay old cookie 401 |
| 9 | Session persists after refresh | PASS | browser probe step 12; e2e `FE-RTE-01` (11 routes) |
| 10 | Session expiration | PASS: 7-day absolute expiry (`SESSION_COOKIE_AGE`, not sliding) | `set-cookie: Max-Age=604800`; e2e "expired/invalid session cookie → /login" |
| 11 | Token refresh | N/A: server sessions have no refresh token (by design) | — |
| 12 | Expired / invalid credential on API | PASS: 401 → client redirects with `?reason=expired` | e2e "session ended server-side while on a page…" |
| 13 | Unauthorized dashboard access | PASS: every protected route → `/login?next=…` server-side | e2e "no cookie: every dashboard route redirects"; probe (`/dashboard`, `/settings`, `/inventory`, `/super-admin`) |
| 14 | Protected API without session | PASS: 401 on `/api/w/`, `/api/auth/me`; forged `sessionid` → 401 | curl |
| 15 | Password reset | PASS: generic response, single-use 2 h token, invalidates on use | e2e "validation, loading and generic confirmation"; `test_auth.py` |
| 16 | Workspace created at registration | PASS: atomic user + workspace + owner + brand | `register_user_with_workspace`, e2e register test |
| 17 | Workspace membership checked server-side | PASS | `TenancyMiddleware`, `test_tenancy_isolation.py`, `test_cross_tenant.py` |
| 18 | Switching workspaces / brands | PASS (API-level), UI partially | e2e `FE-NAV-05` pass; `FE-NAV-04` (dropdown) **timeout** — see e2e report |
| 19 | Access after logout | PASS | #8 |
| 20 | Auth state during navigation | PASS | e2e `FE-NAV-02/03`, deep-link `next=` round-trip, open-redirect suite (27/27) |

**Totals:** 20 items: 18 PASS, 1 N/A, 1 partial (UI dropdown timeout, not an auth defect).

## 2. Additional verifications

- **Session fixation:** `start_session()` calls `cycle_key()` on login and on MFA success. Covered by `test_session_auth.py`.
- **CSRF:** login, register, MFA and reset enforce CSRF even before a session exists (`CsrfProtectedMixin`). A mutating call without a token → 403 (e2e `FE-RTE-08`).
- **Open redirect:** 27 hostile `next=` values rejected (`07-auth-redirect-safety`).
- **Infinite loading:** with the backend down, pages show a connection error. Exception: `FE-RTE-07` failed on one page, see e2e report.
- **Rate limiting:** `auth` scope 5/min per client key. **Gap:** with the DRF default `NUM_PROXIES=None` the key is the entire client-supplied `X-Forwarded-For`, so it can be rotated. Mitigated by the new per-account 2FA lockout; the `DRF_NUM_PROXIES` setting was added (set it to the real hop count in production). **No per-account lockout exists for password attempts** (P2, open).
- **Cookie attributes:** `sessionid` HttpOnly, SameSite=Lax, 7 d. `Secure` only under `config.settings.prod`; the currently configured "production" path runs `config.settings.dev` (P1, open).

## 3. Open issues

| ID | Issue | Severity |
|---|---|---|
| P1-12 | Super-admin console needs a Supabase JWT that the restored Django login never issues, so the console is unreachable from the main sign-in and has no 2FA requirement of its own | P1 |
| P1-13 | Integrations page "Test connection" and Razorpay/Instagram "Sync" call Edge Functions with a Supabase JWT → 401 for Django-session users (Shopify and Meta now fall back to Django endpoints) | P1 |
| P2-14 | No per-account lockout for password guessing; IP throttle bypassable via `X-Forwarded-For` until `DRF_NUM_PROXIES` is set | P2 |
| P2-15 | Production path uses dev settings (no `Secure` cookie, `DEBUG=True`, `ALLOWED_HOSTS` incl. `*`) | P1 (see security report) |
