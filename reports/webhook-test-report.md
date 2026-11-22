# Webhook Test Report (Phase 8)

*2026-11-21. Two implementations exist and both were tested: **Django** (`/api/webhooks/<provider>/<brand_uuid>/`) and **Edge Functions** (`webhook-shopify|webhook-razorpay?brand_id=<uuid>`). Signatures were computed with independent reference HMAC implementations over the exact raw bytes. Environments: Django on SQLite (real commit semantics where needed), PGlite with the real schema. No hosted endpoint was reachable (tunnels down, Vercel deployment not found), so no provider-originated live webhook could be received.*

## 1. Results

| # | Scenario | Django Shopify | Django Razorpay | Edge Shopify | Edge Razorpay |
|---|---|---|---|---|---|
| 1 | Valid signed webhook → business record | ✓ (after fixes) | ✓ (after fixes) | ✓ | ✓ |
| 2 | Invalid signature → 401, nothing written | ✓ | ✓ | ✓ | ✓ |
| 2b | Missing signature → 401 | ✓ | ✓ | ✓ | ✓ |
| 2c | Empty-secret HMAC never accepted | ✓ | ✓ | ✓ | ✓ |
| 2d | Wrong shop domain (`X-Shopify-Shop-Domain`) | ✓ 401 (new test) | — | ○ not checked by Edge | — |
| 3 | Duplicate delivery → one record, `duplicate` | ✓ | ✓ | ✓ | ✓ |
| 3b | Same body without delivery id → dedupe on body hash | ✓ | — | ✓ | ✓ |
| 4 | Delayed webhook (older `updated_at`) does not overwrite newer data | ✓ (`shopify_order_update_older.json`) | n/a | ✓ (upsert keeps newest) | n/a |
| 5 | Out-of-order delivery | ✓ (same fixtures) | ○ | ✓ | ○ |
| 6 | Malformed payload → 400 **after** signature check (no parser oracle) | ✓ | ✓ | ✓ | ✓ |
| 7 | Missing required fields | ✓ 400/ignored | ✓ | ✓ | ✓ |
| 8 | DB failure during processing → provider told to retry | ✗ → ✓ (P0-3, P1-4) | ✗ → ✓ | ✓ (500, event not logged) | ✓ |
| 9 | Retry after temporary failure → processed exactly once | ✗ → ✓ (new `TestWebhookRetryRecovery`) | ✗ → ✓ | ✓ | ✓ |
| 10 | Replay of an already processed event | ✓ `duplicate` | ✓ | ✓ | ✓ |
| — | Cross-brand (A's secret to B's URL) → 401 | ✓ | ✓ | ✓ | ✓ |
| — | Body > 1 MiB → 413 | ✓ | ✓ | ✓ | ✓ |
| — | Signature / auth headers not persisted | ✓ | ✓ | ✓ | ✓ |
| — | Workspace/brand association taken from URL + verified integration | ✓ | ✓ | ✓ | ✓ |

Suites: `backend/tests/test_webhooks.py`, `backend/tests/security/test_webhooks.py` (**147 passed**); `serverless/tests/db/webhooks.test.ts`, `e2e_workflows.test.ts` (pass). e2e `FE-PAY-06/07` (signed Razorpay webhook → payments page, once even if delivered twice; unsigned/tampered rejected): **pass**.

## 2. Defects

| ID | Defect | Impact | Fix | Retest |
|---|---|---|---|---|
| **P0-3** | `backend/config/__init__.py` missing → Celery app not loaded → `process_webhook_event_task.apply_async` targeted an AMQP broker on localhost (eager mode never applied) | **Every Django-received webhook was stored but its processing raised** (`kombu OperationalError`); the provider got a 500 | added `config/__init__.py` loading `config.celery.app` | task binds to `commerce_intel`, `task_always_eager=True`; suites green |
| **P1-4** | A redelivery of a stored-but-unprocessed event was answered `duplicate` | combined with P0-3, **every order/payment webhook was silently lost** | unprocessed duplicates are re-enqueued (`status: retrying`); processed ones stay `duplicate` | retry-recovery test with real commits (500 → retry 200 → processed once → replay `duplicate`) |
| P2-18 | Two webhook stacks for the same provider/tables with different idempotency keys (`shopify:<brand>:<id>` vs `shopify:<id>`) | if both URLs are registered, every event is logged twice (business rows stay single thanks to upserts) | **recommendation:** register exactly one endpoint per provider and delete the other route | — |
| P3-19 | Edge Shopify webhook does not check `X-Shopify-Shop-Domain` (Django does) | low (the HMAC is the real authentication) | recommendation | — |
| info | Delhivery webhook returns 501 | honest "not implemented" | — | ✓ |

## 3. Full chain status

Provider → endpoint → signature → event storage → processing → DB update → dashboard:
- **Verified locally end-to-end** for Razorpay (e2e `FE-PAY-07`: signed webhook → `commerce_paymentattempt` → visible once on `/payments`).
- **Provider-originated live delivery: BLOCKED.** No reachable public endpoint exists (both quick-tunnels dead, Vercel deployment not found), and the stored credentials are invalid.
  Steps: deploy the API (or Edge Functions) at a stable HTTPS URL → in Shopify admin (Settings → Notifications → Webhooks) or the Razorpay dashboard, register **one** URL per brand → send the provider's "test" event → confirm a row in `integrations_webhookevent` with `processed=true` and the matching business row.
