# 125 East Commerce Intelligence: End-to-End QA Report

- **Test date:** 2026-11-12 (system timezone Windows/IST; the app runs in UTC, `TIME_ZONE = "UTC"`)
- **Environment:** local dev checkout, `config.settings.dev`, SQLite, LocMemCache, no Redis or Celery worker, no live external APIs
- **Method:** static code review, existing pytest suite, ruff, `tsc --noEmit`, read-only inspection of `backend/db.sqlite3`, review of prior Playwright results, and small adapter probes (no DB writes)
- **Not touched:** no live Shopify, Razorpay or logistics calls, no writes to any store, no secrets read or printed (`backend/.env` was read with values masked)

---

## 1. Executive summary

**Overall: NO-GO.** The dashboard does not show real business data except the Shopify order and revenue cards, and those are not populated either because nothing has ever synced.

### Why external data is not syncing

| # | Cause | Evidence |
|---|---|---|
| 1 | **No integration is connected and the database holds no data.** `integrations_integration`, `commerce_order`, `integrations_syncrun`, `integrations_webhookevent`, and every `tenancy_*` table have 0 rows. | Read-only query on `backend/db.sqlite3` |
| 2 | **Only Shopify orders have a sync path.** There is no Razorpay, Shiprocket/Delhivery, Meta Ads or Instagram client, sync job, webhook endpoint, or writer for `PaymentAttempt`, `Shipment`, `FactAdsDaily` or `FactShopDaily`. Only adapters (normalizers) exist for Razorpay and Shiprocket. | `grep` shows no code outside models and admin that creates these rows |
| 3 | **No scheduler.** There is no Celery beat schedule, no cron, and no `CELERY_*` settings in Django settings. Sync only runs when a user clicks "Sync Store". | `config/celery.py`, `config/settings/*` |
| 4 | **Credentials are missing.** `.env.example` and `.env` list no Shopify, Razorpay, Shiprocket or Meta variables. Credentials are expected through the UI form. | `.env` variable names only |

### Critical calculation issues

- **Most dashboard numbers are fabricated.** `/metrics/` and the P&L page invent COGS (32% of net), ad spend (24% of net, or a fixed ₹34,000 when net is 0), gateway fees (2%), freight (6.5% or fixed ₹94,000), overhead (fixed ₹2,50,000), refunds (1.2% of gross), new customers (81% of orders), Instagram followers (42,850) and engagements (1,800).
- **The Overview, P&L, Marketing, Payments, Logistics and Integrations pages ship hard-coded demo data as their default state.** If the API fails or returns empty, the user sees realistic-looking fake numbers with no "demo" label.
- **The Shopify ingest ignores refunds and does not exclude cancelled orders** from revenue totals.

### Highest-priority risks

1. Business decisions made on fabricated profit, ROAS and delivery figures (F-01, F-02, F-03).
2. Revenue overstated by cancelled and refunded orders (F-06, F-07).
3. Order sync silently truncates at 2,500 orders and reports success (F-10).
4. Webhook processing runs in an unmanaged thread, not a queue (F-14).
5. The integrations page shows Shopify as "connected, synced 15 minutes ago" by default, even though the DB has no integration (F-04).

### Scope and limitations

Live API reconciliation (source ↔ DB ↔ dashboard) could not be run: no Shopify, Razorpay or logistics credentials were supplied, and the DB is empty. Those tests are **BLOCKED — CREDENTIALS REQUIRED** (section 10). Nothing in this report is based on guessed or mock data presented as real.

---

## 2. Architecture and data flow (as found)

- **Frontend:** Next.js App Router, TypeScript, Tailwind, Supabase JS for auth. Pages: overview, shopify, marketing, payments, logistics, pnl, integrations, team, settings. Calls go through `frontend/src/lib/api.ts`.
- **Backend:** Django 5 + DRF modular monolith (`accounts`, `tenancy`, `integrations`, `commerce`, `analytics`, `alerts`, `billing`). Auth is a Supabase JWT validated over HTTP, plus Django sessions.
- **DB:** SQLite locally (`DATABASE_URL` commented out). The README and docs say PostgreSQL + RLS. `RLSMiddleware` exists but is **not in `MIDDLEWARE`**, so RLS context is never set.
- **Cache:** LocMemCache (Redis commented out). **Jobs:** Celery task exists, no worker or beat config.

| Integration | Implemented | Notes |
|---|---|---|
| Shopify | Order sync (REST `2024-10`) + order webhook | No products, variants, inventory, refunds or fulfillment sync |
| Razorpay | Adapter only | No endpoint, client or ingestion |
| Shiprocket / Delhivery | Adapter + status map only | UI and metrics say "Delhivery" |
| Meta Ads | Provider enum only | No code |
| Instagram | Provider enum only | No code |

**Data flow actually wired:** Shopify REST → `sync_shopify_orders` (HTTP request, synchronous) → `Order`/`OrderLine`/`Customer` → `/shopify/stats/` (5-minute cache) → Shopify, Overview and P&L pages. Every other metric is synthesised in `analytics/views.py` or in page components.

**Timezone:** the backend is UTC throughout; `Brand.timezone` is returned but never used for date bucketing (`FactShopDaily` says "brand's local timezone" but has no writer).

---

## 3. Test environment and prerequisites

Variables the app reads: `DEBUG`, `SECRET_KEY`, `ALLOWED_HOSTS`, `DATABASE_URL`, `REDIS_URL`, `CORS_ALLOWED_ORIGINS`, `SESSION_COOKIE_DOMAIN`, `CSRF_COOKIE_DOMAIN`, `CELERY_BROKER_URL`, `CELERY_RESULT_BACKEND`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and optionally `INTEGRATION_ENCRYPTION_KEY`.

Missing and needed for live tests: Shopify store domain + Admin API token + webhook secret (stored per brand through the UI), Razorpay key id/secret/webhook secret, Shiprocket credentials, Meta Ads access token + ad account ID. Details in section 10.

---

## 4. Test results by module

Severity scale: Critical, High, Medium, Low, Informational.

### 4.1 Shopify

| ID | Test case | Expected | Actual / evidence | Status | Severity |
|---|---|---|---|---|---|
| SH-01 | Valid credentials, live sync | Orders pulled into DB | No credentials, DB empty | BLOCKED | High |
| SH-02 | Missing credentials | Clear 4xx error | `sync_shopify_orders` raises `ValueError`, view returns 400 (`shopify/sync.py`, `views.py`) | PASS | Informational |
| SH-03 | 401/403/404 handling | Distinct safe messages | Handled in `sync.py` lines for 401, 403, 404 | PASS | Informational |
| SH-04 | Rate limit (429) / retry | Backoff and retry | 429 falls into the generic `>= 400` branch and fails the whole sync; no `Retry-After` handling | FAIL | Medium |
| SH-05 | Pagination | All pages fetched | `max_pages=10` × 250 = 2,500 orders max; hitting the cap ends normally and the run is marked SUCCESS with no warning | FAIL | High |
| SH-06 | Incremental sync | Uses `updated_at_min` or a stored cursor | Always re-pulls the last 90 days by `created_at_min`; `SyncCursor` is never used. Updates to orders older than 90 days are never seen | FAIL | Medium |
| SH-07 | Products, variants, inventory, locations | Synced | Not implemented. `Product`/`ProductVariant` tables are never written; `OrderLine.variant` is never set | FAIL | High |
| SH-08 | Refunds | Refund amounts stored | `normalize_order` ignores `refunds`. Probe: a refunded order yields no refund field | FAIL | Critical |
| SH-09 | Cancelled orders | Excluded from revenue | `cancelled_at` is stored but no aggregate filters on it (`/shopify/stats/`, `/metrics/`) | FAIL | Critical |
| SH-10 | Timezone boundaries | Brand-timezone day buckets | `since = now() - days`, rolling UTC window; `Brand.timezone` unused | FAIL | Low |
| SH-11 | Duplicate / repeated sync | No duplicates | `update_or_create` on `(brand, provider, provider_id)` with `unique_together` | PASS | Informational |
| SH-12 | Updated record | Update applied | Upsert applies it. **But** the sync path has no `source_updated_at` guard, so a sync can overwrite newer webhook data with older data | FAIL | Medium |
| SH-13 | Webhook HMAC | Invalid signature rejected | `verify_webhook` uses `hmac.compare_digest` over the raw body; missing secret returns False | PASS | Informational |
| SH-14 | Webhook secret never saved | Secret persisted | If the user leaves the webhook-secret field empty, `api_secret` is stored as `""` and **every** webhook returns 401 silently | FAIL | High |
| SH-15 | Webhook idempotency | Dedup by `X-Shopify-Webhook-Id` | Dedupe works when the header exists. Without it, `event_id` is built from the millisecond timestamp, so replays are not deduplicated | FAIL | Medium |
| SH-16 | Webhook topics | orders, refunds, cancelled, products | Only `orders/*` is processed; other topics are saved and marked processed with no action | FAIL | High |
| SH-17 | Webhook processing reliability | Queue with retry | Handler starts a `threading.Thread` that calls the Celery task function directly. No queue, no persistence, lost on restart. The retry policy is unreliable outside a worker | FAIL | High |
| SH-18 | OAuth code exchange | Real token exchange | `exchange_code` returns `f"shpat_{code[:16]}"`, a fabricated token | FAIL | High |
| SH-19 | Money parsing | Correct minor units | `"1499.999"` truncates to 149999 (no rounding); `"1,499.00"` and `"1e3"` silently become 0 | FAIL | Low |
| SH-20 | Multi-currency | Not summed across currencies | Orders keep their own `currency`; totals sum all currencies together, labelled in the brand currency | FAIL | Medium |
| SH-21 | Sync trigger authorization | Admin only | Any workspace member (`HasTenantAccess`) can trigger a sync; only POST/DELETE of integrations is admin-gated | FAIL | Low |
| SH-22 | Sync blocks request | Async job | Up to 10 pages × 20 s timeout run inside the HTTP request | FAIL | Medium |
| SH-23 | DB write failure | Run marked FAILED, rolled back | Per-page `transaction.atomic()` plus `except` marking FAILED. Earlier pages stay committed (partial data) but the run is marked FAILED, which is correct | PASS | Informational |
| SH-24 | Missing-credential decrypt | Safe error | A wrong `SECRET_KEY` makes `decrypt_credentials` raise `InvalidTag` and the webhook path returns 500 | FAIL | Medium |

### 4.2 Marketing and advertising

| ID | Test case | Expected | Actual / evidence | Status | Severity |
|---|---|---|---|---|---|
| MK-01 | Meta Ads integration exists | Client, sync, token handling | Only the provider enum and `FactAdsDaily` model exist. No client, no job, no writer | FAIL | Critical |
| MK-02 | Instagram integration | Followers and engagement synced | Not implemented | FAIL | High |
| MK-03 | Spend / impressions / clicks source | From source API | `marketing/page.tsx` shows 4 hard-coded campaigns, ₹42,000 spend, ₹1,75,560 attributed, 4.12 ratio | FAIL | Critical |
| MK-04 | `/metrics/` `ad_spend`, `blended_roas`, `blended_cac` | Real facts | `ad_spend = net × 0.24` (or fixed ₹34,00,000 minor when net is 0), `attributed_revenue = spend × 4.18`, so ROAS is always exactly 4.18 and CAC is derived from `orders × 0.81` | FAIL | Critical |
| MK-05 | Zero denominators | Safe | ROAS, CAC and engagement guard against zero | PASS | Informational |
| MK-06 | CTR / CPC / CPM / frequency | Calculated from stored data | Not computed on the backend. `calculations.md` says CPC uses outbound clicks but CTR uses "clicks" without defining which | NOT TESTED | Medium |

### 4.3 Payments (Razorpay)

| ID | Test case | Expected | Actual / evidence | Status | Severity |
|---|---|---|---|---|---|
| PY-01 | Webhook endpoint | Receives events | No Razorpay route in `integrations/urls.py` (Shopify only) | FAIL | High |
| PY-02 | Payment ingestion | `PaymentAttempt` rows | No code writes `PaymentAttempt` | FAIL | High |
| PY-03 | Signature verification | HMAC-SHA256 over raw body | Adapter logic is correct, but unreachable (no endpoint) | PASS (unit only) | Informational |
| PY-04 | Status mapping | Unknown statuses not treated as paid | Unknown statuses (`created`, `partially_refunded`, `refund.processed`) default to `authorized`; partial refunds not represented | FAIL | High |
| PY-05 | Fees, tax on fees, settlements | Stored | No fee, tax or settlement fields; gateway fee is `net × 2%` | FAIL | High |
| PY-06 | Refund volume, disputes | From source | `open_disputes_count` is hard-coded `0`; Payments page numbers (₹1,32,450, ₹4,200, UPI split) are hard-coded | FAIL | Critical |
| PY-07 | Order mapping | `OrderPaymentLink` populated | No code creates links | FAIL | High |
| PY-08 | Live reconciliation | Compare vs Razorpay | No credentials | BLOCKED | High |

### 4.4 Logistics

| ID | Test case | Expected | Actual / evidence | Status | Severity |
|---|---|---|---|---|---|
| LG-01 | Provider sync / webhook | Shipments ingested | None. `Shipment` is never written | FAIL | High |
| LG-02 | Webhook auth | Verified | `ShiprocketAdapter.verify_webhook` returns True for **any** non-empty `X-Api-Key`. Not wired today, but is an auth bypass the moment it is | FAIL | High |
| LG-03 | Status mapping | Unknown → "unknown" | Unknown codes (including lost/damaged) become `IN_TRANSIT`, which overstates progress | FAIL | Medium |
| LG-04 | Delivery % | Delivered shipments / total | `/metrics/` uses *fulfilled orders / orders*. The Overview page labels this "Delivered", but fulfilled does not mean delivered | FAIL | High |
| LG-05 | Logistics page data | Real shipments | Five hard-coded AWBs and named customers in `logistics/page.tsx` | FAIL | Critical |
| LG-06 | Provider naming | One provider | Metrics and UI say "Delhivery"; the adapter is Shiprocket | FAIL | Low |
| LG-07 | RTO and COD charges | Reflected in P&L | Freight is `net × 6.5%` or a fixed ₹94,000; RTO and COD fees not modelled | FAIL | High |

### 4.5 P&L

See also section 5.

| ID | Test case | Expected | Actual / evidence | Status | Severity |
|---|---|---|---|---|---|
| PL-01 | Refunds | From Shopify refund records | `ref = gross × 0.012` on the page | FAIL | Critical |
| PL-02 | P&L foots | Gross − discounts − refunds − taxes = net | The refund line is shown but not subtracted. Net = backend `gross − discount − tax`, so the lines do not add up | FAIL | High |
| PL-03 | COGS | From catalogue cost | `net × 0.32`; there is no cost field on `ProductVariant` | FAIL | Critical |
| PL-04 | Ad spend, freight, overhead | From sources / settings | Constants ₹34,000, ₹94,000, ₹2,50,000 regardless of period or data | FAIL | Critical |
| PL-05 | Demo baseline arithmetic | Internally correct | `gateway_charges_minor: 284860` is **10× too low** (2% of 142,434,000 is 2,848,680), so the baseline CM1 and EBITDA are also overstated | FAIL | Medium |
| PL-06 | Tax treatment | Documented | `net_sales = gross − discount − tax` assumes line prices are tax-inclusive. For tax-exclusive stores net is understated by the tax. The policy is not documented | FAIL | High |
| PL-07 | Shipping revenue vs cost | Separate | Shipping collected is shown as `+shipping` on the Shopify page but not in net, and freight is a fabricated cost | FAIL | Medium |
| PL-08 | Zero / no-data state | Empty or "no data" | The page shows the demo baseline (e.g. ₹14.2 L revenue) when the API fails or returns empty | FAIL | Critical |
| PL-09 | `/metrics/` consistency with P&L page | Same numbers | Backend uses its own 32% COGS / 24% ad spend; page uses 32% COGS / fixed ad spend. The two disagree for the same brand | FAIL | High |
| PL-10 | Division safety | No NaN/Infinity | Percentages guard `net > 0` | PASS | Informational |

### 4.6 Backend, database, jobs and frontend

| ID | Test case | Expected | Actual / evidence | Status | Severity |
|---|---|---|---|---|---|
| BE-01 | Pytest suite | All green | **28 passed, 1 failed** (`test_shopify_sync_trigger` expects 200 with no credentials and no mock; the endpoint correctly returns 400. The test is stale) | FAIL | Medium |
| BE-02 | Tenant isolation | No cross-tenant access | `test_tenancy_isolation.py` and alerts isolation tests pass; non-members get 404 | PASS | Informational |
| BE-03 | Postgres RLS | Active | `RLSMiddleware` is not in `MIDDLEWARE` and dev runs SQLite, so RLS is not enforced | FAIL | High |
| BE-04 | Input validation | 4xx on bad input | `?limit=abc` or an invalid `cursor_created_at` on `/shopify/stats/` raises `ValueError`/`ValidationError` → 500; `limit=-5` returns wrong results; negative `days` allowed | FAIL | Medium |
| BE-05 | Cache invalidation | Fresh after sync | Only windows 7/30/90/180 are cleared, so other `days` values stay stale up to 5 min. With LocMemCache a multi-worker deployment gets per-process caches | FAIL | Low |
| BE-06 | Orders with no date | Excluded from window | `Q(source_created_at__isnull=True)` includes undated orders in every window | FAIL | Low |
| BE-07 | Scheduled sync | Periodic | None configured | FAIL | High |
| BE-08 | Last success vs last attempt | Shown separately | `SyncRun` records both, but the UI only shows `last_synced_at` | FAIL | Low |
| BE-09 | Failed syncs visible | Surfaced | `last_error_message` is returned by the integration API; the UI reads it for the toast only | PASS | Informational |
| BE-10 | Overlapping syncs | Locked | No lock; two clicks start two syncs | FAIL | Low |
| BE-11 | Production settings default | Safe | `manage.py`, `wsgi.py` and `asgi.py` default to `config.settings.dev` (`DEBUG=True`, `ALLOWED_HOSTS=["*"]`, `CORS_ALLOW_ALL_ORIGINS=True` with credentials). Production must remember to override | FAIL | High |
| BE-12 | Credential encryption key | Dedicated key | The key is derived from `SECRET_KEY` with no KDF salt, so rotating `SECRET_KEY` makes all stored credentials undecryptable | FAIL | Medium |
| BE-13 | Hard-coded secrets in source | None | `authentication.py` hard-codes a Supabase project URL and anon key as defaults. The anon key is designed to be public, but it should still come from config | FAIL | Low |
| BE-14 | Lint | Clean | `ruff`: 7 errors (6 auto-fixable) | FAIL | Low |
| BE-15 | Frontend type-check | Clean | `tsc --noEmit` exit 0 | PASS | Informational |
| BE-16 | Frontend lint and build | Clean | `next lint` / `next build` not run | NOT TESTED | Low |
| FE-01 | Overview loading/error state | Error or empty banner | `catch` only `console.error`s; the page keeps the hard-coded ROAS 4.18, CAC ₹420, delivery 92.4%, 42,850 followers, +18.4% growth. Nothing is labelled "sample" | FAIL | Critical |
| FE-02 | Integrations page | Real status | `DEFAULT_APPS` has Shopify as "connected" with account `125-east-apparel.myshopify.com` synced 15 minutes ago, plus other apps as connected. On API error it "keeps current state", so fake connections are shown | FAIL | High |
| FE-03 | Missing data shown as zero | "No data" | Shopify page uses `data?.… \|\| 0`, so no data is indistinguishable from zero | FAIL | Medium |
| FE-04 | Overview "orders" fallback | 0 | `order_count \|\| 1` makes an empty store show 1 order | FAIL | Low |
| FE-05 | Currency label | Per order currency | `paise()` uses the brand currency symbol; Overview hard-codes ₹ | FAIL | Low |
| FE-06 | `/metrics/` endpoint used | Used by the dashboard | No frontend page calls `/metrics/`; Overview and P&L each re-derive numbers client-side | FAIL | Medium |
| FE-07 | Existing Playwright suite | Passing | Latest `results.json` (2026-11-12, 25 tests) is all green; the earlier run in `e2e/run.log` (2026-11-11) had 48 failures out of 117. Passing e2e tests do not exercise real data (empty DB) | PASS (limited) | Informational |

---

## 5. Calculation verification

No live source records were available, so "independent result" is what the correct formula gives for the stated inputs. Fixtures below are **test data, not live data**.

| Metric | Formula / definition in code | Independent result | Dashboard / code result | Variance | Status | Notes |
|---|---|---|---|---|---|---|
| Net sales | `gross − discount − tax` (`adapter.py`) | For a refunded order (gross 1000, discount 100, refund 900): net should be about 0 | Adapter returns 900 (probe, refunds ignored) | +900 (100%) | FAIL | Refunds and cancellations are missing |
| Revenue / day | `net / days` | Same, but with cancelled orders removed | Includes cancelled | Not quantifiable without data | FAIL | |
| COGS | `net × 0.32` | Needs per-variant cost | Constant | Unknown | FAIL | Fabricated |
| Gateway fee | `net × 0.02` | Needs Razorpay fee + GST on fee | Constant | Unknown | FAIL | Fabricated |
| Demo gateway fee | 2% of 142,434,000 | 2,848,680 | 284,860 | −2,563,820 (90%) | FAIL | Off by 10× |
| CM1 | `gross profit − (ads + gateway + freight)` | Needs real costs | Built on fabricated inputs | Unknown | FAIL | |
| Blended ROAS | `attributed / spend` | Needs Meta data | Always 4.18 | n/a | FAIL | |
| AOV | `net / orders` | Same, excluding cancelled | Includes cancelled | Unknown | FAIL | Definition OK, inputs wrong |
| Delivery % | `delivered / total` | Needs shipments | `fulfilled orders / orders` | n/a | FAIL | Fulfilled ≠ delivered |
| P&L footing | `gross − disc − refunds − tax = net` | 154,000,000 − 4,200,000 − 1,800,000 − 5,566,000 = 142,434,000 | Baseline foots; the live path (`ref = gross × 1.2%`) does not subtract refunds | Equal to the fabricated refund | FAIL | |
| `to_minor_units("1499.999")` | Round to 2 dp | 150000 | 149999 | −1 paisa | FAIL | Truncates |
| Division by zero | Guards present | n/a | No NaN/Infinity | | PASS | |

---

## 6. Cross-platform reconciliation

| Source A | Source B | Entity | Source value | Stored value | Dashboard value | Difference | Status |
|---|---|---|---|---|---|---|---|
| Shopify | DB | Orders, 90 days | not queried (no credentials) | 0 rows | 0 or demo | n/a | BLOCKED |
| Razorpay | DB | Payments | not queried | 0 rows | hard-coded | n/a | BLOCKED |
| Shopify | Logistics | Fulfillments ↔ shipments | not queried | 0 rows | hard-coded | n/a | BLOCKED |
| Meta Ads | DB | Spend / revenue | not queried | 0 rows | hard-coded | n/a | BLOCKED |
| DB | P&L page | Revenue and costs | n/a | 0 rows | demo baseline ₹14.2 L | Entire figure is non-source | FAIL |

---

## 7. Root-cause analysis

| Issue | Symptom | Confirmed cause / hypothesis | Evidence / location | Business impact | Recommended fix |
|---|---|---|---|---|---|
| F-01 | Profit, ROAS, CAC, delivery %, followers unchanged or implausible | **Confirmed:** values are computed from constants | `analytics/views.py` ("simulated/restated"), `pnl/page.tsx` L63–L116, `app/page.tsx` L68–L90 | Wrong spending and scaling decisions | Remove fakes; return `null` plus "not connected" until a source exists |
| F-02 | Same | **Confirmed:** demo state doubles as initial state | `marketing`, `payments`, `logistics`, `pnl`, `app/page.tsx` | Users cannot tell sample from live data | Initial state = loading/empty; gate demos behind an explicit demo flag with a visible banner |
| F-03 | Marketing, payments, logistics have no real data | **Confirmed:** no clients, jobs or writers | Missing `meta`, `razorpay`, `logistics` clients; tables never written | Whole sections unusable | Build ingestion per integration (see section 8) |
| F-04 | Integrations page shows fake "connected" | **Confirmed** | `integrations/page.tsx` `DEFAULT_APPS`, silent `catch` | False sense of working integrations | Default to disconnected; show an error state on API failure |
| F-05 | Nothing syncs | **Confirmed:** no integration row, no scheduler | DB counts, `config/celery.py` | No data in any dashboard | Connect Shopify in a test store; add beat schedule |
| F-06 | Revenue includes cancelled orders | **Confirmed** | No `cancelled_at` filter in aggregates | Overstated revenue and AOV | Filter `cancelled_at IS NULL` per documented policy |
| F-07 | Refunds absent | **Confirmed** | `normalize_order` has no refund handling; no refund table | Overstated net revenue | Ingest `refunds` and subtract by refund date (or store as negative transactions) |
| F-08 | Tax policy unclear | **Confirmed ambiguity** | `net_sales = gross − discount − tax` | Net wrong by the tax if prices are tax-exclusive | Read `taxes_included` from the shop and document the policy |
| F-09 | Webhooks 401 | **Hypothesis:** empty secret saved | `integrations/views.py` stores `api_secret = ""` | Real-time updates never arrive | Require the webhook secret, or use the app client secret |
| F-10 | Large stores silently truncated | **Confirmed** | `max_pages=10` and SUCCESS status | Missing orders with no warning | Paginate to completion; mark PARTIAL if capped |
| F-11 | Stale updates | **Confirmed** | `created_at_min` only; `SyncCursor` unused | Late refunds or edits missed | Use `updated_at_min` with a stored cursor |
| F-12 | Webhook thread | **Confirmed** | `shopify/views.py` `threading.Thread` | Lost events on restart | Use `.delay()` with a worker, plus a periodic sweeper for unprocessed events |
| F-13 | RLS and dev-by-default settings | **Confirmed** | `rls_middleware.py` not installed; `manage.py` default | Defence in depth missing; insecure production defaults | Add the middleware under Postgres; default to prod settings or fail without an env var |
| F-14 | Stale failing test | **Confirmed** | `tests/test_shopify_dashboard.py::test_shopify_sync_trigger` | CI red | Mock `requests.get` with a fixture response |

---

## 8. Prioritized remediation plan

**P0 — Critical (financial figures wrong or fake)**
1. Delete the fabricated values (F-01) and demo defaults (F-02, F-04). Owner: full-stack. Regression: with an empty DB every card shows "No data / not connected", never a number.
2. Exclude cancelled orders and ingest refunds (F-06, F-07). Owner: backend. Regression: a fixture with one cancelled and one partially refunded order gives the hand-calculated net.
3. Document the tax and revenue policy (F-08). Owner: product + finance.

**P1 — High (core integrations missing)**
4. Connect Shopify to a dev store and run an end-to-end sync (F-05). Add `updated_at_min` cursor sync, fix the page cap (F-10, F-11), fix the webhook secret handling (F-09), move webhook processing to the queue (F-12), sync products and inventory.
5. Build Razorpay ingestion: webhook endpoint, payment and refund tables, fees, order linking (F-03).
6. Build Shiprocket/Delhivery ingestion; fix `verify_webhook`; count delivery from shipments (F-03, LG-02, LG-04).
7. Build Meta Ads ingestion into `FactAdsDaily`.
8. Production settings and RLS (F-13).

**P2 — Medium**
9. Rate-limit retry/backoff, input validation for `limit`/cursor/`days`, cache invalidation for all windows, a sync lock, a real scheduler, multi-currency handling, and a stable credential-encryption key.

**P3 — Low**
10. Fix the stale test, clean the 7 ruff errors, show last-attempt and last-success separately, label currencies correctly, remove hard-coded Supabase defaults, and rename "Delhivery" to match the provider.

---

## 9. Regression test checklist

- [ ] Empty DB: no dashboard card shows a non-zero money or ratio value.
- [ ] API failure: the UI shows an error state, not sample data.
- [ ] Order fixtures: cancelled, partially refunded, fully refunded, tax-inclusive and tax-exclusive, and multi-currency.
- [ ] Shopify sync with 3 pages, a 429 response, a repeated sync, an updated record, and a DB failure mid-page.
- [ ] Order count: source API count equals DB count for the same window (UTC and brand timezone).
- [ ] Webhooks: bad signature, duplicate id, missing id, out-of-order event, refund and cancel topics.
- [ ] Razorpay: captured, failed, authorized-only, partial refund, duplicate webhook, bad signature, unknown status.
- [ ] Shiprocket: each status code, unknown code, bad token.
- [ ] `/shopify/stats/?limit=abc`, `limit=-1`, bad cursor, `days=-5` return 400.
- [ ] Cross-tenant access returns 404 for stats, metrics, integrations and webhooks.
- [ ] P&L lines sum to the total; the demo baseline gateway fee is correct.

---

## 10. Limitations and outstanding access

| Blocked / not tested | What is needed |
|---|---|
| Live Shopify sync and counts (SH-01, all reconciliations) | Shopify dev-store domain, Admin API token with `read_orders`, `read_products`, `read_inventory`, webhook secret; ideally a store with cancelled, refunded and 250+ orders |
| Razorpay lifecycle (PY-08) | Razorpay **test-mode** key id/secret and webhook secret |
| Logistics (LG-*) | Shiprocket (or Delhivery) sandbox credentials and sample AWBs |
| Meta Ads | Access token, ad account ID, permissions list |
| Postgres/RLS behaviour | A running Postgres 16 instance (Docker compose in `infra/`) |
| Celery retries | Redis + a worker |
| Frontend lint/build, Playwright against live data | Time to run `next build`; real data in the DB first |
| Visual and responsive checks, accessibility | Not part of this pass |

---

## 11. Final sign-off

- Shopify: **FAIL** (order sync works in principle; no refunds, truncation, no scheduler, not connected)
- Marketing and ads: **FAIL** (not implemented, fake data shown)
- Payments: **FAIL** (not implemented, fake data shown)
- Logistics: **FAIL** (not implemented, fake data shown)
- P&L calculations: **FAIL** (inputs fabricated)
- Backend/database: **CONDITIONAL** (tenant isolation tests pass; settings, RLS and jobs need work)
- Frontend: **FAIL** (fake defaults, silent errors)
- **Overall release recommendation: NO-GO**
