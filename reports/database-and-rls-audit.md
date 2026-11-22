# Database & Row-Level-Security Audit (inventory)

*2026-11-21. Sources: `supabase/migrations/*.sql` (18 files incl. 2 added today), Django models/migrations, **read-only** catalog queries against the hosted project (Postgres 17.11, role `app_user`). No hosted data was modified.*

## 1. Schema overview (hosted DB, 46 public tables)

| Domain | Tables | Tenant keys |
|---|---|---|
| Identity | `accounts_user`, `accounts_usermfa`*, `accounts_mfachallenge`*, `accounts_mfarecoverycode` | `id` / `user_id` |
| Tenancy | `tenancy_workspace`, `tenancy_workspacemember`, `tenancy_brand`, `tenancy_brandmember`, `tenancy_invite`, `tenancy_auditlog` | `workspace_id` (+ `brand_id`) |
| Commerce | `commerce_customer`, `commerce_order`, `commerce_orderline`, `commerce_product`, `commerce_productvariant`, `commerce_paymentattempt`, `commerce_orderpaymentlink`, `commerce_shipment`, `commerce_ordershipmentlink`, `commerce_trackingevent` | `workspace_id`, `brand_id` |
| Integrations | `integrations_integration` (AES-256-GCM `encrypted_credentials`), `integrations_syncrun`, `integrations_synccursor`, `integrations_webhookevent` (partitioned monthly: `webhookevent_2026_10/11/12/default`), `integrations_rawpayload` (partitioned) | `workspace_id`, `brand_id` |
| Analytics / alerts | `analytics_factadsdaily`, `analytics_factshopdaily`, `alerts_alert`, `billing_subscription` | `workspace_id`, `brand_id` |
| Platform (new, uncommitted) | `platform_modules`, `workspace_module_permissions`, `user_module_permissions`, `admin_audit_logs` | `workspace_id` / `user_id` |
| Django internals | `django_session`, `django_migrations`, `django_content_type`, `auth_*`, `_schema_migrations` | — |

\* created by Django migrations (owner `app_user`), not by `supabase/migrations`.

**Not present anywhere:** inventory levels/locations/movements, influencers, campaigns, tracking links, click IDs, attributed orders, commissions.

## 2. RLS status (hosted)

- `relrowsecurity = true` on **all 46** public tables. An event trigger `ensure_rls` (`rls_auto_enable`) enables RLS on new tables automatically. That's why the four new module tables are protected on the hosted DB even though their migration never enables RLS.
- Policies use the helpers `is_member_of_workspace()`, `has_workspace_role()`, `has_brand_access()`, `current_tenant_workspace_id()`, `current_app_user_id()`, written in `(SELECT …)` initplan form for performance.
- Tables with **RLS on but no policy** (deny-all for clients): `accounts_usermfa`, `accounts_mfachallenge`, `platform_modules`, `workspace_module_permissions`, `user_module_permissions`, `admin_audit_logs`, `django_*`, `auth_*`.
- `commerce_orderline`, `commerce_orderpaymentlink`, `commerce_ordershipmentlink`, `commerce_trackingevent` carry only an INSERT policy, so clients cannot read them. Harmless, but inconsistent with `commerce_order`.

## 3. Roles

| Role | Used by | RLS applies? | Finding |
|---|---|---|---|
| `anon` | browser before login | yes | Table-level ALL on the 4 module tables (blocked by RLS-with-no-policy). Revoked by `20261121150000` / `20261121150100` |
| `authenticated` | browser with a Supabase JWT, Edge user client | yes | **Table-level SELECT/INSERT/UPDATE/DELETE on `accounts_user`, `accounts_mfarecoverycode`, `integrations_integration`** (P0, see §4) |
| `app_user` | Django | **no: `rolbypassrls = true`** | Tenant isolation on the Django path depends entirely on application filters (P2) |
| `service_role` | Edge Functions, Next super-admin API | no (bypass by design) | Key kept server-side (verified absent from the client bundle) |

## 4. Migration drift on the hosted project (P0)

`_schema_migrations` on the hosted DB lists **13** applied versions, ending at `20261112000013`. Not recorded:

| Migration | Effect of it being absent |
|---|---|
| `20261110000011_security_hardening.sql` | **Column-level protection never applied.** `authenticated` keeps table-level UPDATE on `accounts_user` (self-row policy) → can set `is_superuser`, `mfa_enabled`, `is_active`, `password`, and read `password`/`mfa_secret`. Can INSERT `accounts_mfarecoverycode`. Can read `integrations_integration.encrypted_credentials` |
| `20261112000014_auth_invites_and_provisioning_hardening.sql` | Unknown: its objects may or may not exist (unrecorded) |
| `20261121000015_fix_commerce_stats_auth_guard.sql` | Unknown |
| `20261121134000_super_admin_module_permissions.sql` | Tables exist, so it was applied manually without being recorded |

Impact: any person who can obtain a Supabase session (e.g. by signing up through the Supabase-auth flow that was live in the working tree) could mark their account super-admin. The super-admin API trusts `accounts_user.is_superuser` and uses the service role, giving read/write over **every tenant**. The same session could turn off its own Django 2FA. Exploitation was **not** attempted on the hosted project; it was reproduced on a local replay with the hosted grants (`serverless/tests/db/privileges.test.ts`, step 2 asserts the exploit works before the fix).

**Fix (written, not applied):** `supabase/migrations/20261121150100_reassert_client_column_privileges.sql`. It re-asserts least privilege idempotently and adds a `BEFORE UPDATE` guard trigger on privileged `accounts_user` columns for client roles.

## 5. Other observations

- `SECURITY DEFINER` functions `is_super_admin(uuid)` and `get_user_effective_modules(uuid, uuid)` were executable by `anon` with arbitrary ids, which lets anyone probe super-admin status. Fixed in `20261121150000` (revoked from anon; self-only unless super-admin).
- `get_brand_commerce_stats` counts cancelled orders in sales (same defect as Django; Django fixed today; the SQL function is not called by any code path, so it was left as-is and noted).
- Indexes: tenant indexes exist on all fact tables (`idx_*_workspace`, `idx_*_brand`, composite `(brand_id, source_created_at)` from `…_performance_optimizations.sql`). No missing-index issue found for the dashboard queries at the current data volume (2 orders, 1 payment on the hosted DB).
- Webhook events are deduplicated by the unique `(brand_id, provider, event_id)` constraint plus the `trg_webhookevent_dedupe` trigger (serverless) and `get_or_create(event_id)` (Django). The two implementations use different `event_id` formats (see the webhook report).
- Migration replay: all 18 migrations replay cleanly on a fresh database (PGlite) with 2 documented shims (`serverless/tests/db/pglite_db.ts`).
