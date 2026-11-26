# DATA_SECURITY_REPORT — Phase 3

| Requirement | Status | Evidence |
|---|---|---|
| RLS on sensitive tables | ✅ RLS enabled on all 10 new tables (incl. dedupe). Live: RLS on all 48 existing tables | migration §9; live catalog query |
| Workspace isolation | ✅ new tables: `SELECT` only where `has_brand_access(brand_id)`; another workspace reads 0 rows of refunds, reconciliation, quality issues, order history, raw payloads | `Phase 3 data security` test |
| Users can't write engine output | ✅ `INSERT/UPDATE/DELETE/TRUNCATE` revoked from `authenticated`, no write policies; insert into `commerce_refund` refused; quality issues can't be silenced | same test |
| Customer information protection | ✅ contact/address data stored once (`commerce_customer`); raw payloads PII-minimised; attribution keeps only path + UTM (other query params dropped) | unit test "PII"; ingestion test greps raw for emails/phones |
| Restricted raw payload access | ✅ existing policy (owner/admin/analyst of the workspace); dedupe table service-role only; `ingest_raw_payload` / `mark_raw_payload` service-role only and refuse brand/workspace mismatches | security test |
| Service-role usage | ✅ engines (`reconcile_brand`, `run_data_quality_checks`, `run_data_pipeline_maintenance`, `ingest_raw_payload`, `mark_raw_payload`) are `SECURITY INVOKER` and executable by `service_role` only | security test calls them as a user → refused |
| SECURITY DEFINER minimised | `track_commerce_order_history` (trigger only, revoked from users) and `refresh_daily_fact_shop` (existing). The latter now has an owner/admin guard, tested **with** `EXECUTE` granted to simulate Supabase defaults | security test |
| Protected Edge Functions | ✅ `reprocess-raw`: `verify_jwt=true`, cron secret or workspace owner/admin (viewer → 403); syncs keep membership + module checks | ingestion test |
| Safe error logging | ✅ redacting logger; raw-payload errors store the DB error message, never credentials | code review |
| No secret exposure | ✅ no secrets in code, migrations or tests (synthetic values only); Vault for cron secrets (Phase 1) | grep in Phase 1 audit |

## Live findings (read-only)
- `refresh_daily_fact_shop` live: **not** executable by `authenticated` → not exposed today; the guard is defense in depth.
- `get_brand_commerce_stats` live: `SECURITY INVOKER` → RLS applies.
- Still open from Phase 1 (unchanged by Phase 3): live `get_user_effective_modules` lacks its caller check and anon can execute it. Fix = apply the existing migration `20261121150000` (awaiting approval).

## Residual risks
| Risk | Note |
|---|---|
| `integrations_webhookevent.raw_body` keeps full webhook bodies incl. PII | existing behaviour; propose a retention window (needs approval) |
| Analysts can read raw payloads | they're PII-minimised; tighten to owner/admin if you prefer |
| `commerce_customer.email/phone` readable by all workspace members incl. viewers | existing policy; column-level restriction possible if wanted |
