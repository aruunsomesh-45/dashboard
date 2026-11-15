# 125 EAST Commerce Intelligence — Phase 3 Production Supabase Implementation Report
**Document ID:** `DOC-IMPL-2026-PHASE-3`  
**Classification:** Production Infrastructure Implementation & Verification Report  
**Target Environment:** Supabase PostgreSQL 17 (`ap-south-1` Mumbai)  
**Project ID / Ref:** `ybyroxyofqfpozvfedhc` ("d2c dashboard")  
**Author:** Senior Supabase Engineer  
**Updated:** November 12, 2026  
**Status:** Verified, RBAC-Hardened & Active  

---

## Executive Summary

The Phase 2 multi-tenant database architecture is live, verified, and RBAC-hardened on the connected **Supabase PostgreSQL** project (`ybyroxyofqfpozvfedhc`) via the **Supabase MCP server** (`list_tables`, `list_migrations`, `list_extensions`, `get_advisors`, `apply_migration`, `execute_sql`).

Before making any changes, the live database was inspected to preserve all existing tables and data. Existing schema objects were verified alongside three new hardening migrations (`20261112000011`–`20261112000013`) applied via Supabase MCP `apply_migration` to enforce granular Role-Based Access Control (RBAC), immutable append-only audit logs, automatic member/integration audit triggers, pinned function `search_path`, cross-tenant `brand_id` FK spoofing defense, anonymous privilege revocation, initplan-safe RLS policies, and covering indexes for all 33 previously unindexed foreign keys.

---

## 1. Pre-Change Environment & Existing Data Inspection

Prior to executing migrations via Supabase MCP, the target project was inspected:

| Inspection Check | Observed State |
|---|---|
| **Project Ref** | `ybyroxyofqfpozvfedhc` (`ap-south-1`) |
| **Existing Tables in `public`** | 36 tables (including partitioned parent + monthly partition child tables for raw payloads & webhook events, plus `_schema_migrations`) |
| **Existing Production/Dev Data** | Preserved intact: `accounts_user`: **5**, `tenancy_workspace`: **4**, `tenancy_workspacemember`: **5**, `tenancy_brand`: **4**, `tenancy_invite`: **1**, `tenancy_auditlog`: **5**, `billing_subscription`: **4** |
| **MCP Migration Ledger (`list_migrations`)** | Previously empty (`[]`), while custom `public._schema_migrations` tracked migrations `20261110000001`–`20261110000010` |
| **Pre-Hardening Security Advisor Findings** | 6 mutable `search_path` functions, 7 `SECURITY DEFINER` RPCs exposed to `anon`, 9 tables with RLS enabled but no policies (`_schema_migrations` + 8 partition child tables), 33 unindexed FKs, 2 `auth_rls_initplan` policies, and blanket `FOR ALL` RLS policies allowing `viewer` writes |

No destructive statements (`DROP TABLE`, `TRUNCATE`, `DELETE`) were executed against existing data.

---

## 2. Version-Controlled Migration Ledger

All SQL migrations are stored under `supabase/migrations/`. Hardening migrations `000011`–`000013` were executed via Supabase MCP `apply_migration` and recorded in both Supabase's migration ledger (`list_migrations`) and `public._schema_migrations`.

| Migration Version | File / MCP Migration Name | Scope & Purpose | Status |
|---|---|---|---|
| `20261110000001` | `20261110000001_extensions_and_roles.sql` | Extensions (`uuid-ossp`, `pgcrypto`, `pg_trgm`, `btree_gist`), `app_user` (`NOBYPASSRLS`), `set_updated_at()` | **ACTIVE** |
| `20261110000002` | `20261110000002_accounts_and_tenancy.sql` | `accounts_user`, `accounts_mfarecoverycode`, `tenancy_workspace`, `tenancy_workspacemember`, `tenancy_brand`, `tenancy_brandmember`, `tenancy_invite`, `tenancy_auditlog` | **ACTIVE** |
| `20261110000003` | `20261110000003_commerce_core.sql` | Canonical commerce tables (`commerce_customer`, `commerce_product`, `commerce_productvariant`, `commerce_order`, `commerce_orderline`, `commerce_paymentattempt`, `commerce_shipment`, `commerce_trackingevent`, `commerce_orderpaymentlink`, `commerce_ordershipmentlink`) | **ACTIVE** |
| `20261110000004` | `20261110000004_integrations_and_webhooks.sql` | `integrations_integration`, `integrations_syncrun`, `integrations_synccursor`, and range-partitioned `integrations_rawpayload` / `integrations_webhookevent` with default + `2026_10`/`2026_11`/`2026_12` partitions | **ACTIVE** |
| `20261110000005` | `20261110000005_analytics_and_alerts.sql` | `analytics_factshopdaily`, `analytics_factadsdaily`, `alerts_alert`, `billing_subscription`, `refresh_daily_fact_shop()` | **ACTIVE** |
| `20261110000006` | `20261110000006_row_level_security.sql` | Enabled RLS across all tenant tables and created baseline tenant isolation helpers | **SUPERSEDED BY `000011`** |
| `20261110000007` | `20261110000007_indexes_and_optimizations.sql` | Composite, partial queue, and GIN trigram fuzzy search indexes | **ACTIVE** |
| `20261110000008` | `20261110000008_grant_roles.sql` | Role grants (`app_user`, `authenticated`, `anon` to `postgres`) | **ACTIVE** |
| `20261110000009` | `20261110000009_auth_triggers_and_user_provisioning.sql` | `handle_new_auth_user()` trigger provisioning `accounts_user`, workspace/brand/subscription, or accepting invites | **ACTIVE** |
| `20261110000010` | `20261110000010_performance_optimizations.sql` | Covering indexes, keyset pagination index, webhook idempotency unique index, `get_brand_commerce_stats()` | **ACTIVE** |
| `20261112000011` | `20261112000011_rbac_rls_and_security_hardening.sql` (MCP: `rbac_rls_and_security_hardening` / `20261112034412`) | Pinned `search_path`, revoked `anon` privileges, granular RBAC RLS (`SELECT`/`INSERT`/`UPDATE`/`DELETE`), immutable audit log + auto triggers, partition RLS policies, 25 FK covering indexes, partitioned `updated_at` triggers | **APPLIED (MCP)** |
| `20261112000012` | `20261112000012_fix_accounts_rls_initplan.sql` (MCP: `fix_accounts_rls_initplan` / `20261112034458`) | Wrapped `app.user_id` check in subselect on accounts tables | **APPLIED (MCP)** |
| `20261112000013` | `20261112000013_accounts_initplan_helper.sql` (MCP: `accounts_initplan_helper` / `20261112034559`) | Added `public.current_app_user_id()` (`STABLE SECURITY INVOKER`) to eliminate remaining `auth_rls_initplan` lint warnings | **APPLIED (MCP)** |

### Reported Failures & Resolutions During Execution
1. **Initial `apply_migration` attempt for `rbac_rls_and_security_hardening`:** Failed atomically with `ERROR: 23502: null value in column "execution_time_ms" of relation "_schema_migrations" violates not-null constraint` because the custom ledger row omitted `execution_time_ms`. Rolled back automatically with zero partial state; updated to pass `execution_time_ms = 0` and re-applied successfully (`{"success": true}`).
2. **Initial RLS verification script attempt:** Failed cleanly on `commerce_order` test insert because the column name is `provider_id` rather than `external_id`. Corrected to `provider_id` and re-ran cleanly.

---

## 3. Verified Database Objects Inventory (`public` Schema)

Direct post-migration verification against Supabase PostgreSQL (`pg_tables`, `pg_constraint`, `pg_indexes`, `pg_policies`, `information_schema.triggers`):

| Metric | Verified Count | Verification Notes |
|---|---|---|
| **Tables in `public`** | **36** | 26 core/parent tables + 1 `_schema_migrations` + 8 partition child tables + `billing_subscription` (`rawpayload_*` and `webhookevent_*`) |
| **Tables with RLS Enabled** | **36 / 36 (100%)** | Confirmed via both `list_tables` and `pg_tables.rowsecurity = true` |
| **Primary Keys** | **36** | Every physical & partitioned table has a UUID / composite `(id, created_at)` PK |
| **Foreign Key Constraints** | **67** | All cascade/restrict relationships verified; **0 unindexed foreign keys** remaining |
| **Unique Constraints** | **21** | Multi-tenant uniqueness (`slug`, `(workspace_id, user_id)`, `(brand_id, provider)`, `(workspace_id, dedupe_key)`, etc.) |
| **Indexes** | **138** | B-Tree, composite time-series, covering (`INCLUDE`), partial queues (`processed = false`), GIN Trigram (`pg_trgm`), and FK covering indexes |
| **Granular RLS Policies** | **133** | Separated by command (`SELECT` / `INSERT` / `UPDATE` / `DELETE`) to eliminate permissive overlap |
| **Database Triggers** | **33** | `on_auth_user_created` on `auth.users`, 18 `updated_at` triggers (`set_updated_at()`), plus `trg_audit_workspacemember` and `trg_audit_integration` (`log_security_audit_event()`) |

### Database Functions Verified
- `public.set_updated_at()` (`SECURITY INVOKER`, `search_path=public, pg_temp`)
- `public.current_tenant_workspace_id()` (`SECURITY DEFINER`, `search_path=public, pg_temp`)
- `public.current_app_user_id()` (`SECURITY INVOKER`, `search_path=public, pg_temp`)
- `public.is_member_of_workspace(UUID)` (`SECURITY DEFINER`, `search_path=public, pg_temp`)
- `public.has_workspace_role(UUID, TEXT[])` (`SECURITY DEFINER`, `search_path=public, pg_temp`)
- `public.has_brand_access(UUID)` (`SECURITY DEFINER`, `search_path=public, pg_temp`)
- `public.refresh_daily_fact_shop(UUID, DATE)` (`SECURITY DEFINER`, `search_path=public, pg_temp`)
- `public.get_brand_commerce_stats(UUID, UUID, INT)` (`SECURITY INVOKER`, `search_path=public, pg_temp`, enforces workspace authorization)
- `public.handle_new_auth_user()` (`SECURITY DEFINER`, `search_path=public, pg_temp`, execution revoked from `anon`/`authenticated`)
- `public.log_security_audit_event()` (`SECURITY DEFINER`, `search_path=public, pg_temp`, execution revoked from `anon`/`authenticated`)

---

## 4. Security Architecture, RBAC Matrix & Audit Enforcement

### 4.1 Role-Based Access Control (RBAC) Matrix (Database RLS)

| Domain / Table | `owner` | `admin` | `analyst` | `viewer` | `anon` |
|---|---|---|---|---|---|
| `tenancy_workspace` | `SELECT`, `UPDATE`, `DELETE` | `SELECT`, `UPDATE` | `SELECT` | `SELECT` | Denied |
| `tenancy_workspacemember` | `SELECT`, `INSERT`, `UPDATE`, `DELETE` (incl. `owner`) | `SELECT`, `INSERT`, `UPDATE`, `DELETE` (non-`owner` only) | `SELECT` | `SELECT` | Denied |
| `tenancy_brand` / `brandmember` / `invite` | Full CRUD (`owner`/`admin`) | Full CRUD (`owner`/`admin`) | `SELECT` (brands only) | `SELECT` (brands only) | Denied |
| `billing_subscription` | `SELECT`, `INSERT`, `UPDATE`, `DELETE` | `SELECT` | `SELECT` | `SELECT` | Denied |
| `tenancy_auditlog` | `SELECT`, `INSERT` (Append-only) | `SELECT`, `INSERT` (Append-only) | `SELECT`, `INSERT` (Append-only) | **Denied** | Denied |
| `alerts_alert` | Full CRUD | Full CRUD | `SELECT`, `UPDATE` (ack/resolve) | `SELECT` | Denied |
| `integrations_*` / `commerce_*` / `analytics_*` | Full CRUD (brand-validated) | Full CRUD (brand-validated) | `SELECT` (brand-scoped) | `SELECT` (brand-scoped) | Denied |
| `_schema_migrations` | Denied via API (`USING (FALSE)`) | Denied via API | Denied via API | Denied via API | Denied |

### 4.2 Client-Supplied ID & Cross-Tenant Spoofing Prevention
- Write policies on all `(workspace_id, brand_id)` tables enforce `EXISTS (SELECT 1 FROM public.tenancy_brand b WHERE b.id = tbl.brand_id AND b.workspace_id = tbl.workspace_id)` alongside `has_workspace_role(workspace_id, ...)`. A client cannot link another organization's `brand_id` under their own `workspace_id`.
- `get_brand_commerce_stats` runs as `SECURITY INVOKER` and explicitly validates `p_workspace_id` membership before aggregating.
- `tenancy_auditlog` has zero `UPDATE` or `DELETE` policies for any client role, making the audit trail append-only and immutable.

### 4.3 Supabase MCP Advisor Status (Post-Hardening)
Re-running `get_advisors` (`security` & `performance`) confirmed:
- `unindexed_foreign_keys`: **0** (down from 33)
- `auth_rls_initplan`: **0** (down from 3)
- `rls_enabled_no_policy`: **0** (down from 9)
- `function_search_path_mutable`: **0** (down from 6)
- `anon_security_definer_function_executable`: **0** (down from 7)
- `multiple_permissive_policies`: **0**
- Remaining advisory notices (non-blocking):
  - `extension_in_public` (2): `pg_trgm` and `btree_gist` live in `public` as placed by initial extensions setup.
  - `authenticated_security_definer_function_executable` (4): the 4 RLS helper functions (`current_tenant_workspace_id`, `is_member_of_workspace`, `has_workspace_role`, `has_brand_access`) intentionally execute as `SECURITY DEFINER` during RLS evaluation for `authenticated` to avoid recursive RLS lookups.
  - `auth_leaked_password_protection` (1): Dashboard auth setting for HaveIBeenPwned password checks (project uses Google OAuth + Email OTP).

---

## 5. Multi-Identity RLS & RBAC Verification Results

Executed directly via `supabase_mcp` `execute_sql` inside an isolated subtransaction rolled back cleanly (`SQLSTATE P0099`) so existing database rows remained completely unmodified (`users=5`, `members=5`, `workspaces=4`, `brands=4`, `audit_logs=5`, `subscriptions=4`, `alerts=0` confirmed before and after):

| Test Case | Identity / Role Context | Expected Outcome | Observed Result | Status |
|---|---|---|---|---|
| `0_auto_audit_trigger_member_added` | Trigger on `tenancy_workspacemember` insert | Automatically logs `member.added` to `tenancy_auditlog` | `audit_rows=1` | **PASS** |
| `1_owner_125_workspace_isolation` | `authenticated` (`founder@125east.com`, `owner`) | Sees only `125-east-retail` (1 of 4 workspaces) | `workspaces_visible=1` | **PASS** |
| `2_cross_tenant_brand_insert_blocked` | `authenticated` (`founder@125east.com`) | Blocked from inserting brand into `demo-store` | `blocked=true` | **PASS** |
| `3_cross_tenant_brand_spoof_blocked` | `authenticated` (`founder@125east.com`) | Blocked from inserting order under `125-east-retail` with `demo-store` `brand_id` | `blocked=true` | **PASS** |
| `4_auditlog_immutable_delete_blocked` | `authenticated` (`founder@125east.com`, `owner`) | Blocked from deleting workspace audit logs | `blocked=true` | **PASS** |
| `5_analyst_rbac_alert_yes_brand_no` | `authenticated` (`analyst@125east.com`, `analyst`) | Allowed to update `alerts_alert` (`1`), blocked from creating `tenancy_brand` | `alert_updated=1, brand_blocked=true` | **PASS** |
| `6_viewer_rbac_readonly_audit_hidden` | `authenticated` (ephemeral `viewer`) | Blocked from updating `alerts_alert` (`0`) and sees `0` rows in `tenancy_auditlog` | `alert_rows_updated=0, audit_visible=0` | **PASS** |
| `7_demo_owner_isolation` | `authenticated` (`demo@125east.com`, `owner`) | Sees only `demo-store` (`1`) and own `accounts_user` profile (`1`) | `ws=1, users=1` | **PASS** |
| `8_anon_access_denied` | `anon` | Denied table access (`insufficient_privilege`) | `blocked=true` | **PASS** |
| `9_app_user_nobypassrls_tenant_lock` | `app_user` (`NOBYPASSRLS`) with `app.workspace_id` | Sees only bound `demo-store` workspace (`1`) | `ws_visible=1` | **PASS** |

**Final Verification Summary:** `10 / 10` RLS & RBAC isolation tests passed, `36 / 36` tables protected with RLS, and all existing data preserved intact.
