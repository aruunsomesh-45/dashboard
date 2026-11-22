# Database & Multi-Tenant Security Test Report (Phase 5)

*2026-11-21. Isolated environments only: PGlite (real migrations, real RLS, `SET ROLE authenticated` with JWT claims) and Django on SQLite. Hosted DB: **read-only** catalog/settings inspection; no exploitation attempted.*

## 1. Results

| # | Test | Environment | Result | Evidence |
|---|---|---|---|---|
| 1 | Workspace A user reads Workspace B rows (orders, customers, payments, integrations, sync runs, webhook events, ads facts) | PGlite | **PASS**: 0 rows | `serverless/tests/db/schema_rls.test.ts`, `security.test.ts` |
| 2 | A updates / deletes B rows | PGlite | **PASS**: 0 rows affected | same |
| 3 | Change brand/workspace id in an Edge Function request | PGlite + handlers | **PASS**: 403 (non-member), 404 on `integration_id` of another tenant (no existence oracle) | `security.test.ts`, `functions_sync.test.ts` |
| 4 | Change slug/brand id in a Django API request | Django/SQLite | **PASS**: 401/403/404 on all 30+ routes for an outsider; positive control proves the routes are real | `backend/tests/test_cross_tenant.py`, `test_tenancy_isolation.py` (261 passed) |
| 5 | Read another workspace's integration credentials | Django + PGlite | **PASS** (API never returns credentials; PGlite: column not granted) | `test_cross_tenant.py` (`SECRET_MARKERS`), `privileges.test.ts` |
| 6 | Ownership-field manipulation (`workspace_id` in body) | Django | **PASS**: server derives tenant from URL + membership, ignores body | `test_tenancy_isolation.py` |
| 7 | Role escalation inside a workspace (admin → owner, self role change, last-owner demotion) | Django | **PASS** | `test_invites_and_rbac.py` |
| 8 | Cross-tenant webhook (brand A secret → brand B URL) | Django + Edge | **PASS**: 401, nothing written | `test_webhooks.py`, `webhooks.test.ts` |
| 9 | **Client privilege on `accounts_user` (hosted grants)** | PGlite replay with the hosted grants | **FAIL before fix → PASS after**: a signed-in user could set its own `is_superuser` / `mfa_enabled`, read `password`/`mfa_secret`, insert MFA recovery codes, read `encrypted_credentials` | `serverless/tests/db/privileges.test.ts` (step 2 asserts the exploit reproduces first) |
| 10 | Hosted DB: are the protections deployed? | hosted, read-only | **FAIL (open)**: `20261110000011_security_hardening.sql` never applied; table-level grants present; signups open with auto-confirm | catalog queries, `GET /auth/v1/settings` (`disable_signup:false`, `mailer_autoconfirm:true`) |
| 11 | Can a PostgREST client forge tenant context (`app.workspace_id` / `app.user_id` GUCs)? | hosted, read-only | **PASS**: no public function calls `set_config`; PostgREST cannot `SET` | `pg_proc` scan |
| 12 | `SECURITY DEFINER` RPCs callable by anon with arbitrary ids | PGlite | **FAIL before fix → PASS after**: `get_user_effective_modules` for another user now raises; anon revoked | `module_permissions.test.ts` |
| 13 | Module-permission tables writable by clients | PGlite | **PASS** after `20261121150000` (RLS + revoke) | `module_permissions.test.ts` |
| 14 | Service-role key absent from the browser bundle | build output | **PASS** | grep of `frontend/.next/static` against the configured key value |
| 15 | Django path relies on RLS? | hosted | **INFO / P2**: `app_user` has `BYPASSRLS`; isolation is application-enforced only (and verified by #4) | `pg_roles` |
| 16 | Workspace A/B isolation on the hosted DB with real users | — | **BLOCKED**: would require creating accounts and data in production. Covered by #1–#9 on isolated replicas | — |

## 2. Critical finding: self-service super-admin on the hosted project (P0)

**Chain:** public anon key (shipped in every page) → `POST /auth/v1/signup` (open, auto-confirmed) → JWT → `PATCH /rest/v1/accounts_user?id=eq.<own id>` `{"is_superuser": true}` (table UPDATE granted + self-row policy) → the `/api/super-admin/*` handlers trust `accounts_user.is_superuser` and use the **service role**, giving read/write across all tenants, user suspension, and module control. The same request shape with `{"mfa_enabled": false}` turns off one's own 2FA, and inserting into `accounts_mfarecoverycode` mints a recovery code for the Django 2FA challenge.

**Root cause:** migration drift. The hosted `_schema_migrations` stops at `20261112000013`, so the column-level `REVOKE/GRANT` in `20261110000011` never ran.

**Fix applied in the repo (not deployed):** `supabase/migrations/20261121150100_reassert_client_column_privileges.sql`:
- `REVOKE ALL … FROM anon` on all public tables.
- `accounts_user`: SELECT only non-secret columns; UPDATE only `first_name`, `last_name`.
- Trigger `trg_accounts_user_guard_privileged` rejects client-role changes to `id, email, password, is_active, is_staff, is_superuser, mfa_enabled, mfa_secret`, even if a broad grant reappears.
- `accounts_mfarecoverycode`: revoked from clients.
- `integrations_integration`: SELECT on all columns except `encrypted_credentials`.

**Retest:** `privileges.test.ts`: 4/4 steps pass (clean replay; drift → fix; trigger-only defence; server role unaffected).

**Required owner actions (before anything else):**
1. Review and apply `20261121150000` and `20261121150100` to the hosted project (`supabase db push`, or run them in the SQL editor), then record them in `_schema_migrations`.
2. Audit for prior abuse: `SELECT id, email, created_at FROM accounts_user WHERE is_superuser OR is_staff;` and recovery codes created outside Django (`accounts_mfarecoverycode` rows whose user has no `accounts_usermfa.is_enabled`).
3. Until the auth architecture is settled, consider disabling Supabase sign-ups (`Authentication → Providers → Email → Enable sign-ups: off`), or at least turn on email confirmation.
4. Reconcile the remaining unrecorded migrations (`…14`, `…15`, `…134000`) and adopt one migration runner.

## 3. SQL review for missing tenant filters

- Django: every brand-scoped view resolves `request.tenant` in `TenancyMiddleware` and filters `workspace=request.tenant.workspace, brand=brand`; `TenantManager` is the default manager on tenant models. No unscoped `.objects.all()` was found on tenant models in views (`grep` of `apps/*/views.py`, `*_views.py`).
- Edge Functions: user-initiated reads go through the RLS-scoped user client. Service-role writes always carry `workspace_id` / `brand_id` taken from the verified integration row, never from the request body.
- Webhooks: the tenant is derived from the brand in the URL **and** the integration whose secret verified the signature.
