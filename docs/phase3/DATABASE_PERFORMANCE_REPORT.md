# DATABASE_PERFORMANCE_REPORT — Phase 3

**Benchmark:** `deno task test:perf` (`tests/perf/perf.test.ts`). Synthetic brand: 50,000 orders spread over 400 days, 100,000 order lines, 50,000 payments, 20,000 customers, plus a second brand with 5,000 orders. Engine: **PGlite (Postgres compiled to WASM, single connection)**. Timings are relative evidence only; hosted Postgres will be faster. Query plans (index use) are what carries over. All 7 steps passed (2026-11-23).

For scale: the live store creates roughly 35–50 orders a day (Shopify, read-only check), so 50,000 orders is about 3 years of history.

## Results
| Measurement | Result |
|---|---|
| Dashboard order window (brand + date, newest first, 1,000 rows) | Index scan on `(brand_id, source_created_at)`; 39 ms |
| Current dashboard pattern: page through a 2×30-day window (7,500 rows) and sum in the app | **8 pages / 192 ms** of DB time, plus 8 sequential HTTP round trips in production |
| Same total as one SQL aggregate | **13 ms**, 1 round trip, identical result (asserted) |
| Payment stats (current pattern reads every payment of the brand, no date filter) | **50 pages** vs one `GROUP BY` (100 ms) |
| `fetchAll` cap | at 50,000 payments the current code stops reading and **silently under-reports** totals |
| `reconcile_brand` first run / re-run (50k payments + 50k orders) | 47.3 s / 23.2 s (PGlite); re-run creates 0 links (idempotent) |
| `run_data_quality_checks` | 22.0 s (PGlite) |
| Reconciliation lookups | `idx_commerce_order_brand_number`, `idx_payment_brand_order_ref`, `idx_reconciliation_brand_status` all used (index scans) |
| One customer's metrics (view) | 4 ms |

Note on the reconciliation numbers: the synthetic seed gave payments references like `"1500"`, which match both an order *id* `1500` and an order *number* `1500`. The engine refused to guess on all 49,250 such payments and flagged them `NEEDS_REVIEW` (98,550 warnings), linking only the 750 unambiguous ones. That is the intended behaviour, shown at volume.

## Indexes
Existing indexes already cover brand + time on orders, payments and facts (several covering with `INCLUDE`), trigram search on order number, email, phone and AWB, and partial indexes for unprocessed webhooks.

Added in Phase 3:
| Index | Serves |
|---|---|
| `commerce_order (brand_id, order_number)` | reconciliation by order number |
| `commerce_order (brand_id, source_updated_at DESC)` | incremental sync, change queries |
| `commerce_order (brand_id, gateway_payment_ref)` partial | order ↔ payment by checkout payment id |
| `commerce_order (brand_id, checkout_cart_token)` partial | Phase 4 visitor → order bridge |
| `commerce_paymentattempt (brand_id, merchant_order_ref)` partial | payment → order by notes |
| `commerce_shipment (brand_id, order_ref)` partial | shipment → order |
| `commerce_trackingevent UNIQUE (shipment_id, occurred_at, raw_status, location)` | scan dedupe |
| `integrations_rawpayload (brand_id, provider, created_at)` WHERE failed | re-processing queue |
| `integrations_syncrun (integration_id, started_at DESC)`, unique running | health view, overlap lock |
| refunds: `(order_id)`, `(payment_attempt_id)`, `(brand_id, source_created_at)` | joins, lists |
| marketing/GA4: `(brand_id, report_date DESC)`, `(brand_id, campaign_id, report_date)`, `(brand_id, transaction_id)` | reporting, attribution |
| reconciliation `(brand_id, entity_type, status)`; quality `(brand_id, severity)` WHERE open | review queues |

## Views vs. materialised data
- Views (not materialised): `analytics_meta_ad_daily_metrics` (ratios), `commerce_customer_metrics`, `integrations_sync_health`. They are cheap per brand or per customer, and always current.
- No new materialised views. Engine output (reconciliation, quality) is stored, because it's expensive and read often. Unchanged rows aren't rewritten (`IS DISTINCT FROM` guard), which keeps WAL and bloat low.
- No denormalisation beyond what already exists (`analytics_factshopdaily`).

## Recommendations (need your approval — they change frontend business logic)
1. **Replace `fetchAll` + JS sums in `frontend/src/app/api/[[...path]]/route.ts` with SQL aggregate RPCs** (`SECURITY INVOKER`, brand + date parameters). This fixes the silent 50,000-row truncation and turns 8–50 round trips into 1. The revenue formulas must move into SQL unchanged and be verified against the current output.
2. Add a date filter to payment stats (today it reads all-time payments on every load).
3. Scope the hourly reconciliation and quality jobs to recently changed records once a brand passes about 20k orders; today's volume (about 1.5k/month) doesn't need it.
4. Connection usage: the dashboard goes through PostgREST (HTTP), so no pool exhaustion risk. Edge Functions use the REST client too, with no direct DB connections.
