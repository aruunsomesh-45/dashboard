# DATABASE_AUDIT — Phase 3

**Date:** 2026-11-23 · **Scope:** Supabase project `ybyroxyofqfpozvfedhc` (read-only queries) + repo migrations replayed into a local Postgres (PGlite).
**No migration was executed against production.** All Phase 3 changes are in `supabase/migrations/20261124000000_data_normalization.sql` (not applied anywhere yet).

## 1. How this was audited
| Source | Method |
|---|---|
| Repo schema | All 21 migrations replayed in strict mode into PGlite; catalog read from `information_schema` / `pg_constraint` / `pg_indexes` |
| Live schema | Read-only `SELECT`s via `supabase db query --linked` |
| Live vs repo | Column-by-column diff of the 17 commerce / analytics / integration tables: **identical** (only `integrations_syncrun.triggered_by` from the unapplied Phase-1 cron migration differs) |
| Live data | Aggregate counts only (no row contents read) |

## 2. Schemas & tables
- Schemas used: `public` (app), `auth` (Supabase), `vault`, `supabase_migrations`. Live: **48** tables in `public` (incl. 8 monthly/default partitions), RLS on **all**, 133 policies.
- Money: `BIGINT` minor units (paise) + explicit `currency VARCHAR(3)` — exact, no float. `commerce_order.gross_amount` holds the **order total** (Shopify `total_price`).
- Time: `TIMESTAMPTZ` everywhere; daily facts bucket by `tenancy_brand.timezone` (default `Asia/Kolkata`).
- Canonical natural key on every commerce entity: `UNIQUE (brand_id, provider, provider_id)`.

| Domain | Tables (existing) | Reuse? |
|---|---|---|
| Tenancy | tenancy_workspace, tenancy_brand, tenancy_workspacemember, tenancy_brandmember, tenancy_invite, tenancy_auditlog | Reuse |
| Accounts | accounts_user, accounts_mfarecoverycode | Reuse |
| Commerce | commerce_customer, commerce_product, commerce_productvariant, commerce_order, commerce_orderline, commerce_paymentattempt, commerce_shipment, commerce_trackingevent | Reuse + **additive columns** |
| Links | commerce_orderpaymentlink, commerce_ordershipmentlink (with `match_method`, `confidence`) | Reuse as-is (the reconciliation engine writes them) |
| Integration | integrations_integration, integrations_syncrun, integrations_synccursor, integrations_webhookevent (partitioned), integrations_rawpayload (partitioned), integrations_webhookevent_dedupe | Reuse; rawpayload **extended** |
| Analytics | analytics_factshopdaily, analytics_factadsdaily (account-level) | Reuse (factadsdaily kept for the dashboard) |
| Admin | platform_modules, workspace_module_permissions, user_module_permissions, admin_audit_logs, billing_subscription, alerts_alert | Not touched |

## 3. Keys, relationships, constraints (commerce)
- PK `id UUID` everywhere; partitioned tables use `(id, created_at)`.
- FKs: every commerce/analytics row → `tenancy_workspace` + `tenancy_brand` (`ON DELETE CASCADE`); `commerce_order.customer_id → commerce_customer (SET NULL)`; `commerce_orderline.order_id → commerce_order (CASCADE)`, `.variant_id → commerce_productvariant (SET NULL)`; `commerce_productvariant.product_id → commerce_product`; `commerce_trackingevent.shipment_id → commerce_shipment`; link tables → both sides (CASCADE); `integrations_syncrun/synccursor.integration_id → integrations_integration`.
- CHECKs: status enums on order financial/fulfilment, payment status/method, shipment canonical status, sync run status; non-negative amounts/counters; confidence 0–1.

## 4. Indexes (summary)
Brand + time composite indexes exist for orders, payments and facts (`(brand_id, source_created_at DESC)`, covering variants with `INCLUDE`), trigram indexes on `order_number`, `email`, `phone`, `awb`, partial indexes on unprocessed webhooks. Gaps found and added in Phase 3: `(brand_id, order_number)` btree, `(brand_id, source_updated_at)`, `(brand_id, merchant_order_ref)`, `(brand_id, order_ref)` on shipments, failed-raw-payload partial index. Full list: DATABASE_PERFORMANCE_REPORT.md.

## 5. Live data findings (aggregates only)
| Check | Result |
|---|---|
| Duplicate orders / payments on the natural key | 0 / 0 |
| Customers sharing an email | 0 |
| Orders without lines | 0 |
| Order lines without a variant link | **3 of 3** (no product sync exists, lines carried no platform variant id) |
| Payment ↔ order links | **0** (nothing wrote the link table) |
| Shipments / products / raw payloads / sync cursors / daily facts | **0 / 0 / 0 / 0 / 0** — tables exist but no code path filled them |
| Non-INR orders | 0 |
| Volume | 3 orders, 2 payments, 10 workspaces/brands, DB 15 MB |

## 6. Defects found
| # | Defect | Fixed in Phase 3? |
|---|---|---|
| D1 | `refresh_daily_fact_shop` used `ts AT TIME ZONE 'UTC' AT TIME ZONE tz`, which dates orders placed 00:00–11:00 IST on the **previous** day (proved on Postgres: 01:30 IST and 09:30 IST → previous date). Not called anywhere yet; facts table empty live. | Yes (+ owner/admin guard) |
| D2 | Original platform statuses discarded (`authorized`/`partially_paid` → `pending`; unknown Razorpay status → `failed`) | Yes: `source_*_status` columns; canonical mapping unchanged |
| D3 | Missing vs zero conflated (unparseable money → 0; ad metrics `NOT NULL DEFAULT 0`) | Yes for all new columns/tables (NULL = unknown) |
| D4 | No refunds model; no subtotal; no order history | Yes |
| D5 | Raw payload, cursor, link, product, shipment, fact tables never written | Raw, cursor, links: yes. Products / shipments / facts need connectors (not in scope) |
| D6 | Dashboard reads every row and sums in JS, capped at 50,000 rows → totals silently truncated above that | Reported with measurements; fix needs approval (frontend change) |

## 7. Reuse vs modify decision
| Table | Decision | Why |
|---|---|---|
| commerce_order | add 13 nullable/defaulted columns | subtotal, refunds, original statuses, gateways, UTM |
| commerce_orderline | add 3 id columns | product/variant matching |
| commerce_paymentattempt | add 5 columns | original status, refunds, merchant order ref |
| commerce_shipment | widen status CHECK (superset) + 5 columns | picked_up / returned / unknown; pickup, last update, return status, order ref |
| commerce_trackingevent | 4 columns + unique scan index | dedupe, raw + canonical status |
| integrations_rawpayload | 7 columns | processing status, hash, error, attempts, source |
| **new** | commerce_refund, commerce_order_history, analytics_meta_ad_daily, analytics_instagram_media(+_snapshot), analytics_ga4_daily, analytics_ga4_transaction, commerce_reconciliation, data_quality_issue, integrations_rawpayload_dedupe | genuinely missing |
| analytics_factadsdaily | unchanged | dashboard depends on it; ad-level detail lives in the new table |

Nothing is dropped or renamed. See DATABASE_RELATIONSHIP_DIAGRAM.md.
