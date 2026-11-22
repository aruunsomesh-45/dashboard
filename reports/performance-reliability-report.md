# Performance & Reliability Report (Phase 15)

*2026-11-21. All numbers are **measured**, on a Windows 11 laptop running the isolated stack (Next production build → Next proxy → Django `runserver` on SQLite, 60 seeded orders). They indicate code-path cost, not production capacity: no production-like host exists to measure (the deployment is not found and the tunnels are dead). Nothing here is extrapolated.*

## 1. Measurements

### API latency through the Next proxy (authenticated, 20 sequential requests each, all HTTP 200 with data)

| Endpoint | p50 | p95 | max | Payload |
|---|---:|---:|---:|---:|
| `GET /api/auth/me` | 21 ms | 32 ms | 36 ms | 560 B |
| `GET …/shopify/stats/?days=30` | 31 ms | 39 ms | 48 ms | 10.8 KB |
| `GET …/metrics/?days=30` | 36 ms | 52 ms | 55 ms | 2.1 KB |
| `GET …/payments/stats/` | 27 ms | 32 ms | 46 ms | 227 B |
| `GET …/logistics/summary/` | 26 ms | 37 ms | 40 ms | 239 B |

(A "direct to Django" column was measured too but discarded: the cookie jar was scoped to `localhost`, so those requests went out unauthenticated and came back as fast 401s. Reporting them would have been misleading.)

### Other measurements

| Item | Value |
|---|---|
| Page TTFB (`/login`, `/dashboard`, static prerendered) | 6–7 ms (local) |
| First-load JS | 149 kB shared; heaviest page `/integrations` 236 kB |
| Live provider round-trip (`test-connection`, read-only) | Razorpay 140 ms, Meta 218 ms, Instagram 275 ms |
| Serverless suite (64 tests incl. PGlite builds) | 50 s |
| Backend suite (666 tests) | 202 s |
| Full E2E (140 tests, 1 worker) | 14 min 54 s |

### Not measured (BLOCKED / not performed)
Concurrent users, concurrent webhook bursts, large datasets (10⁵+ orders), Edge Function cold starts and execution time on Supabase, production DB query plans (the hosted DB holds only 2 orders), sync duration against real APIs (all credentials invalid). Running load against the hosted project or providers was deliberately avoided.

## 2. Code inspection

| Topic | Finding |
|---|---|
| N+1 queries | Shopify stats: one aggregate query + recent orders with `select_related("customer")` and `annotate(Count("lines"))`; `workspaces_for` uses `select_related` + `prefetch_related`. `test_rate_limit_and_queries.py` asserts query counts. No N+1 found in the dashboard paths |
| Indexes | Tenant / brand / `(brand_id, source_created_at)` composites exist (`…000007`, `…000010`); RLS helpers use the initplan `(SELECT …)` form. Adequate for current volume; re-check with `EXPLAIN ANALYZE` once real data exists |
| Caching | Django `LocMemCache`: per process, so it is not shared across gunicorn workers or instances. Tenant-keyed, invalidated on webhook ingest |
| Background work | Celery runs **eager (in-request)**: webhook processing, retries (up to 5, with backoff ignored in eager mode) and syncs run inside the HTTP request. A slow provider or DB makes webhook responses slow, and Shopify drops webhooks that take more than 5 s. Use a real broker or move processing to the Edge pipeline |
| Sync bounds | Edge: 250/page, same-host pagination, 15 s per upstream call, 429 Retry-After honoured. No overall page cap per run, so a very large first sync could exceed the Edge Function wall-clock limit. Add a page budget + cursor resume |
| Race conditions | Webhook dedupe: unique constraint + `get_or_create` / dedupe trigger (safe). TOTP replay check is read-then-write without a row lock: two simultaneous submissions of the same code within milliseconds could both pass (P3) |
| Duplicate jobs | No scheduler exists, so no duplicate scheduled jobs; manual "Sync now" is throttled (6/min) |
| Frontend requests | Dashboard pages issue 2–3 parallel API calls on load; no polling loops observed |
| Single points of failure | the whole API runs on one developer machine behind a quick tunnel (see security P1-20) |

## 3. Suggested targets (once deployed on a real host)

| Metric | Target |
|---|---|
| Dashboard API p95 (≤ 50k orders / brand) | < 300 ms |
| Webhook acknowledgement p95 | < 1 s (hard limit: Shopify 5 s) |
| Login + 2FA round-trips | < 500 ms each |
| Initial sync of 10k orders | < 5 min, resumable |
| Edge Function cold start | < 1 s |

Measure with `k6` or Playwright traces against **staging** with a seeded database, never production.
