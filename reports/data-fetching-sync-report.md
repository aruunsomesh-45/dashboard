# Data Fetching & Synchronisation Report (Phase 9)

*2026-11-21. MOCKED upstream (scripted responses with synthetic records) + real schema (PGlite / Django SQLite). LIVE sync is **BLOCKED**: every stored credential is rejected by its provider (see `live-api-integration-report.md`).*

## 1. Per-integration checklist (MOCKED unless stated)

| # | Requirement | Shopify | Razorpay | Meta Ads | Instagram |
|---|---|---|---|---|---|
| 1 | API request actually made (asserted on the recorded fetch log) | ✓ | ✓ | ✓ | ✓ |
| 2 | Correct credentials used (header / Basic / token asserted) | ✓ | ✓ Basic auth | ✓ | ✓ |
| 3 | Correct workspace (from the verified integration, not the body) | ✓ | ✓ | ✓ | ✓ |
| 4 | Pagination | ✓ Link header (2 pages), same-host only | ✓ count/skip | ✓ `paging.next`, graph host only | n/a |
| 5 | Response validated | ✓ malformed → 502 | ✓ missing `items` → 502 | ✓ | ✓ |
| 6 | Normalised (minor units, statuses, timestamps) | ✓ | ✓ | ✓ | ✓ |
| 7 | Rows inserted / updated | ✓ orders, customers, lines, sync run | ✓ payments | ✓ daily facts | ✓ |
| 8 | Duplicates prevented on re-sync | ✓ (counted as updates) | ✓ | ✓ unique `(brand_id, fact_date)` | ✓ |
| 9 | Failed records tracked | ✓ one bad order → `partial`, others saved | ○ | ○ | ✓ per capability |
| 10 | Sync timestamps / sync runs | ✓ `integrations_syncrun` | ✓ | ✓ | ✓ |
| 11 | Dashboard query returns the stored records | ✓ `get_brand_commerce_stats` equals an independent SQL aggregate (`e2e_workflows` E) | ✓ | ○ | ○ |
| 12 | Frontend displays the values | ✓ e2e (isolated stack: 60 orders, ₹67,716 net via API) — UI assertion failed on test-file encoding, see e2e report | ✓ e2e `FE-PAY-*` | ✗ e2e `FE-MKT-01` (label mismatch) | — |

## 2. Scenarios

| Scenario | Result |
|---|---|
| Initial sync | ✓ |
| Incremental sync (`created_at_min` / cursor) | ✓ code path; cursor persistence via `integrations_synccursor` (MOCKED) |
| Repeated sync | ✓ idempotent |
| Empty response | ✓ success with 0 records |
| Partial response / one bad record | ✓ `partial` |
| Rate limit 429 | ✓ retried after `Retry-After` |
| Network interruption / timeout | ✓ 504 |
| Expired credentials | ✓ 502, integration marked `error`, sync run `failed` |
| DB interruption | ✓ error surfaced (no silent success) |
| Recovery and retry | ✓ re-run after failure succeeds |
| Time-zone boundaries | **✗ (P2, open)**: Django windows use UTC `now − N days`, not brand-local calendar days (`TestBrandLocalDays`, 5 failures) |
| Date-range filtering | ✓ widening the window includes the 100-day-old order (`e2e_workflows` E); `from`/`to` params **not implemented** |

## 3. Fabricated data

| Location | Finding | Action |
|---|---|---|
| `/inventory` | hardcoded "128 SKUs / 94 % in stock / 4 low / 2 out of stock" and "Real-time multi-location stock synchronization is running" | **removed**; explicit "not available yet" state |
| `/influencer` | hardcoded "18 creators / ₹4,82,500 coupon revenue / 4.2x ROAS" | **removed**; explicit "not available yet" state |
| `/shopify` KPI cards | static "+18.4 %" growth text even with zero orders (e2e `FE-SHOP-11`) | **open (P2)**: remove or compute vs previous period |
| Django | `DEMO_MODE=false`; `test_no_fabricated_data.py` (no simulated syncs, no seed fallbacks) passes | ✓ |

## 4. Hosted data reality check (read-only counts, 2026-11-21)

7 users · 9 workspaces · 9 brands · **2 orders · 1 payment · 0 ad-days · 0 products** · 3 webhook events (2 Shopify, 1 Razorpay, processed) · 5 sync runs, **all failed**. The dashboards currently have almost no real data to show.

## 5. Gaps

- Products, variants and inventory are never fetched (no sync for `commerce_product*`).
- Meta ad-set / ad-level entities are not fetched (campaign + account daily insights only).
- No scheduled sync: there is no cron, beat or pg_cron. Data only refreshes on a manual "Sync now".
- Refunds are not reflected in revenue (status only).
