# PHASE_3_TEST_REPORT

**Executed:** 2026-11-23, local machine. Deno 2.9.8; PGlite (Postgres in WASM) with all repo migrations replayed in **strict** mode.
**Data used:** synthetic fixtures shaped like the platforms' documented payloads, plus read-only aggregate checks on the live database. **Nothing in this report is production data processed by the new code**: the Phase 3 migration and functions are not deployed.

## Suite totals
| Suite | Command | Result |
|---|---|---|
| Type check (all Edge Functions) | `deno check supabase/functions/*/index.ts` | ✅ pass |
| Unit | `deno test -A tests/unit` | ✅ **68 / 68** |
| Database / integration | `deno test -A tests/db` | ✅ **22 tests / 163 steps**, 0 failed |
| Next.js API routes (regression) | `deno task test:web` | ✅ **2 tests / 44 steps** |
| Performance (50k orders) | `deno task test:perf` | ✅ 1 test / 7 steps (2m40s) |

All pre-existing tests still pass after the refactor (sync and webhooks now share one pipeline).

## Unit tests (new: `tests/unit/normalization.test.ts`, 15 tests)
| Area | What is proven |
|---|---|
| Money | NULL for missing/garbage vs real 0; exact minor units; no float drift; half-up |
| Currency | ISO upper-casing; invalid values kept visible (not silently "fixed") |
| Timestamps | offset-less courier times read as IST → UTC; explicit offsets respected |
| Status mapping | Shopify canonical + original kept; unknown Razorpay status preserved; full Delhivery table (14 cases) |
| Attribution | UTM extracted and lower-cased; other query params (e.g. email) dropped; referrer → domain |
| Refunds | only successful refund transactions count; "no refunds key" (NULL) ≠ "empty list" (0) |
| Checkout note attributes | allow-list only; payment/order ids validated; cart `?key=` secret never stored |
| Meta / Instagram / GA4 | missing metrics NULL; overlapping purchase types → max; `(not set)` kept; rows without transaction id refused |
| PII | emails, phones, IPs, addresses, free-text notes removed from raw payloads (incl. `note_attributes`); ids and money kept |
| Idempotency input | canonical JSON is key-order independent |

## Integration tests
| Test (file) | Steps | Covers |
|---|---|---|
| Shopify ingestion pipeline (`data_ingestion`) | 9 | raw layer, PII, dedupe on re-fetch, order history, refunds, incremental checkpoint (+ overlap), failure kept as `failed`, checkpoint stops before failure, `reprocess-raw` recovery, viewer → 403, backfill never rewinds, concurrent syncs → 409, `refunds/create` webhook |
| Razorpay ingestion pipeline (`data_ingestion`) | 3 | payment webhook (original status, notes ref, PII-free raw), `refund.processed` + duplicate resend, incremental payment checkpoint |
| Reconciliation engine (`reconciliation_quality`) | 13 | see DATA_RECONCILIATION_REPORT.md (exact ids, look-alikes not linked, ambiguity, partial/over-payment, COD scope, shipments, refunds, variants, attribution, brand isolation, idempotency, **order-side gateway payment id**) |
| Data quality engine | 3 | 13 seeded defects detected with severity; nothing modified/deleted; resolve and re-open |
| Daily facts timezone (bug fix) | 1 | orders at 01:30 and 09:30 IST counted on the right date; facts agree with recomputation |
| Phase 3 data security | 5 | own-brand read, cross-workspace 0 rows, no user writes, engines/ingestion not callable by users, fact-refresh guard (with EXECUTE granted) |
| Scheduled sync (Phase 1 work, still passing) | 12 | cron auth, overlap lock, stale runs, health view |

## Required-by-prompt matrix
| Required | Status |
|---|---|
| Unit: normalisation, currency, timestamps, status mapping, validation, idempotency | ✅ executed |
| Integration: Shopify → orders, Razorpay → payments | ✅ executed (mocked APIs) |
| Integration: Delhivery → shipments, Meta → marketing, Instagram → insights, GA4 → analytics | ⚠ **normalisers unit-tested only**; no connector writes these tables yet |
| Reconciliation: order/payment, order/shipment, refunds, duplicates, unmatched | ✅ executed |
| Data quality: missing, invalid, duplicate, inconsistent, wrong relationships | ✅ executed |
| Performance: query, aggregation, historical retrieval, concurrent sync | ✅ executed (PGlite; concurrency via the overlap-lock test) |
| Real data | ⚠ read-only aggregate checks only. The live dashboard's Shopify/Razorpay/Meta credentials are rejected (Phase 1), so no real records flowed through the new code |

## Master data readiness
Legend: ✅ built and tested locally · ⚠ partial · ❌ missing. **No row is production-verified until the migration is applied and valid credentials are entered.**

| Data Category | Ingestion | Normalization | Validation | Reconciliation | Status |
|---|---|---|---|---|---|
| Orders | ✅ sync + webhook + raw | ✅ | ✅ | ✅ | READY WITH WARNINGS (not deployed) |
| Payments | ✅ sync + webhook + raw | ✅ | ✅ | ✅ exact via order's `razorpay_payment_id` | READY WITH WARNINGS (not deployed) |
| Refunds | ✅ Shopify (orders + `refunds/create`), Razorpay `refund.*` webhook | ✅ | ✅ | ✅ | READY WITH WARNINGS (the Razorpay sync doesn't list refunds; webhook only) |
| Customers | ✅ via orders | ✅ | ✅ (shared email, cross-brand) | n/a (id-only, never merged) | READY WITH WARNINGS |
| Products | ❌ no product sync | ⚠ line-level ids only | ⚠ | ✅ variant linking | NOT READY |
| Shipments | ❌ no Delhivery connector | ✅ (unverified against a real response) | ✅ | ✅ | NOT READY |
| Meta Ads (ad level) | ❌ sync is account-level | ✅ | ⚠ | n/a | NOT READY |
| Instagram organic | ❌ | ✅ | ⚠ | n/a | NOT READY |
| GA4 | ❌ no connector | ✅ | ⚠ | ✅ (transaction ↔ order) | NOT READY |
| Raw ingestion layer | ✅ | n/a | ✅ failures surfaced | n/a | READY WITH WARNINGS |

**Phase 3 overall: READY WITH WARNINGS locally / NOT READY for production.** Blockers: migrations not applied (needs your approval and a migration-history repair, Phase 1 B5), invalid live credentials (Phase 1 B1), connectors for products / Delhivery / ad-level Meta / Instagram / GA4.
