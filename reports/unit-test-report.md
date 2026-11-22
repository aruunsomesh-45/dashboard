# Unit & Integration Test Report (Phase 2)

*2026-11-21. Existing frameworks were used: **pytest + pytest-django** (backend, isolated SQLite `config.settings.test`) and **Deno test** (serverless, mocked upstream + PGlite built from the real migrations). External services are mocked in all of these suites. Live calls are reported separately in `live-api-integration-report.md`.*

## 1. Totals

| Suite | Command | Baseline (before fixes) | Final | Δ |
|---|---|---|---|---|
| Backend (Django) | `cd backend && ..\.venv\Scripts\python -m pytest -q` | 630 tests: **581 passed, 49 failed** | 666 tests: **630 passed, 36 failed**, 0 skipped | +36 new tests; 13 failures resolved |
| Serverless unit | `cd serverless && deno test -A tests/unit` | all pass | all pass | — |
| Serverless unit + DB/functions | `cd serverless && deno task test` | 60 tests: **53 passed, 7 failed** (30 failing steps) | 64 tests / 120 steps: **64 passed, 0 failed** | +4 tests (12 steps) |
| Frontend type-check | `cd frontend && npx tsc --noEmit` | pass | pass | — |

**Coverage.** Serverless (`deno coverage`, `supabase/functions/**`): **92.5 % lines, 83.5 % branches, 98.9 % functions**. Weakest files: `webhook-shopify/handler.ts` 64.7 % branches, `integrations.ts` 65 %, `test-connection` 66 %. Backend: **not measured** (`pytest-cov` is not installed; add it and run `pytest --cov=apps`).

## 2. Areas covered

| Area | Where | Valid / invalid / missing / null / duplicates / upstream errors |
|---|---|---|
| Auth utilities, session, CSRF, redirects | `test_auth.py`, `test_session_auth.py`, `test_auth_and_mfa.py` | yes |
| TOTP / 2FA | `test_totp_mfa.py`, **`test_mfa_hardening.py` (new, 30 tests)** | yes, incl. skew window, replay, lockout, ciphertext tamper |
| Input validation (password strength, email, payload shape) | `test_auth.py`, `serverless/tests/unit/upstream_http.test.ts` | yes |
| Workspace / brand authorization | `test_tenancy_isolation.py`, `test_cross_tenant.py`, `test_invites_and_rbac.py`, `serverless/tests/db/security.test.ts` | yes |
| Module authorization | **`serverless/tests/db/module_permissions.test.ts` (new)** | object/array/garbage shapes, disabled → 403 without an upstream call |
| Shopify order/product/customer normalisation | `serverless/tests/unit/mappers.test.ts`, `test_pipeline.py` | taxes incl./excl., older-update ignored, missing fields |
| Razorpay payment normalisation | `mappers.test.ts`, `test_phase3_connectors.py` | captured/failed/unlinked |
| Meta Ads transformation | `mappers.test.ts`, `test_meta_ads_api.py` | restatement fixtures |
| Instagram processing | `functions_sync.test.ts` | partial permissions, invalid token |
| Webhook signatures | `serverless/tests/unit/signatures.test.ts` (cross-checked against node:crypto), `backend/tests/security/test_webhooks.py` | tamper, wrong secret, empty secret, missing header |
| Webhook dedup / retry | `webhooks.test.ts`, `test_webhooks.py` incl. **new retry-after-failure test** | yes |
| Crypto (AES-GCM, Django-compatible) | `serverless/tests/unit/crypto.test.ts` | wrong key, tamper |
| Retry / timeout / rate limit | `upstream_http.test.ts`, `functions_sync.test.ts` | 429 Retry-After, timeout → 504, malformed JSON → 502 |
| Logging redaction | `serverless/tests/unit/logger.test.ts`, `security.test.ts` | tokens never logged |
| Metrics / currency / dates | `test_metrics.py`, `test_analytics_metrics.py` | **36 spec-ahead failures, see §4** |
| Inventory calculations | — | **not testable: no implementation** |
| Influencer links / UTM / click tracking / attribution / commission | — | **not testable: no implementation** |
| Refund & cancellation calculations | `test_metrics.py::TestCancelledOrders` | cancellation fixed; refunds not modelled |

## 3. Defects found by these suites and fixed

| ID | Defect | Fix | Retest |
|---|---|---|---|
| P0-2 | `requireModuleAccess` treated the JSONB object from `get_user_effective_modules` as an array → `.find` threw → **every non-superuser Shopify/Razorpay/Meta/Instagram sync returned 500** | `_shared/auth.ts`: `isModuleEnabled()` accepts the object (and array) shapes, fails closed | 30 previously failing steps pass; new module tests |
| P0-3 | `backend/config/__init__.py` missing → Celery app never loaded → `@shared_task` bound to the unconfigured default app (eager off, AMQP broker) → **every Django webhook stored but never processed** | Added the standard `config/__init__.py` | Webhook suites 147/147 |
| P1-4 | Django webhook: a delivery whose processing failed was stored as unprocessed and every provider retry was answered "duplicate" → order/payment lost | `webhook_views.py`: unprocessed duplicates are re-enqueued (`status: retrying`) | New `TestWebhookRetryRecovery` (real commit semantics) |
| P1-7 | Cancelled orders counted in revenue, order count, AOV and the funnel | `integrations/views.py`, `analytics/views.py`: aggregates exclude `cancelled_at IS NOT NULL` (orders stay listed) | all 6 `TestCancelledOrders` tests pass |
| P2-9 | "Orders to be shipped" (`paid_unfulfilled_orders`) counted unpaid orders | filter `financial_status="paid"` | `test_orders_to_be_shipped_is_paid_unfulfilled_and_not_cancelled` passes |
| P2-10 | TOTP replay state keyed per user+step, not per secret → re-enrolling within 30 s rejected a valid code | replay key includes a secret fingerprint; `last_used_step` reset on setup/disable | `test_re_enroll_after_disable_issues_a_new_secret` |
| P3 | Edge `wrapHandler` echoed raw exception text in 500 responses | generic message (operator misconfiguration still shown) | `security.test.ts` |
| Test-only | stale tests: Shopify webhooks lacked the shop-domain header; `on_commit` never fired under pytest; positive control used random member ids; freezegun captured DRF's throttle clock at import; migration count hardcoded | tests corrected, each with a comment explaining why | suites green |

## 4. Unresolved (reported as FAILED, not skipped)

`backend/tests/test_metrics.py`: **36 failures**. The file declares itself a contract "where the app has no implementation yet":

| Group | Failing | Nature | Severity |
|---|---:|---|---|
| `TestBrandLocalDays` | 5 | "last N days" windows use UTC `now - N days`, not brand-local calendar days (IST late-evening orders land on the wrong day) | P2 correctness |
| `TestAov` | 2 | per-day AOV with `from`/`to` date ranges (not implemented) | P2 |
| `TestLogisticsRatios` | 2 | NDR % / RTO % definitions differ from `appflow/phases/calculations.md` (got 20.0/30.0) | P2 correctness |
| `TestPaymentRatios` | 3 | `upi_drop_off_rate` not exposed | P3 feature |
| `TestPreviousPeriod` | 7 | `compare=previous_period` not implemented | P3 feature |
| `TestFreshness` | 13 | top-level `freshness` flag not implemented | P3 feature |
| `TestIndianFormatting` | 4 | `formatted` uses Western grouping (₹145,000 instead of ₹1,45,000) | P3 |

Also unresolved: no backend coverage measurement; inventory and attribution logic cannot be unit-tested because it doesn't exist.

## 5. Silent-failure check

- Edge sync functions: partial failures produce a `partial` sync run plus counts. A failed upstream call marks the integration `error` and returns 502/504 (tested).
- Edge webhooks: processing happens before the event log, so a failure returns 500 and the provider retries (tested).
- Django webhooks: previously swallowed in practice (P0-3, P1-4); now fixed and tested.
- `decrypt_totp_secret` used to return the ciphertext on a decrypt failure (masking key problems as a 500 from pyotp). It now fails closed and logs `mfa_secret_decrypt_failed`.
- `check_have_i_been_pwned` deliberately fails open on network errors (2 s timeout). Documented, acceptable.
