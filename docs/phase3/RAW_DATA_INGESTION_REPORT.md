# RAW_DATA_INGESTION_REPORT — Phase 3

## Design
The existing partitioned table `integrations_rawpayload` is reused and extended; nothing new is partitioned.

| Requirement | Column / mechanism |
|---|---|
| Platform name | `provider` |
| External record ID | `entity_id` (Shopify order id, `pay_…`, `rfnd_…`) |
| Raw JSON payload | `payload JSONB` (PII-minimised, see below) |
| Event type | `topic` — logical entity: `order`, `payment`, `refund` (the same payload via sync and webhook is one record) |
| Received timestamp | `created_at` (partition key) |
| Processing status | `processing_status` ∈ pending / processed / failed / skipped |
| Processing timestamp | `processed_at` |
| Error information | `error`, `attempts`, `replayed_at` |
| Workspace reference | `workspace_id`, `brand_id` (+ RLS) |
| How it arrived | `source` ∈ sync / webhook / backfill / reprocess |
| Duplicate prevention | `payload_hash` = SHA-256 of the **original** payload in canonical (sorted-key) JSON; `integrations_rawpayload_dedupe` PK `(brand, provider, topic, entity_id, hash)` |

Writes go through `public.ingest_raw_payload(...)` (service-role only). It refuses a brand that is not in the given workspace, and it returns the existing row with `duplicate=true` for an identical payload. `mark_raw_payload(...)` records the outcome and counts attempts.

Every normalised record keeps its source: `commerce_order.raw_payload_ref` / `commerce_refund.raw_payload_ref` → raw row id.

## Ingestion history
A **changed** payload (e.g. an order that was later refunded) gets a new raw row. An identical re-fetch does not. The raw table is therefore the version history of each source record. Verified: re-sync of 2 unchanged orders → still 2 raw rows; a payment captured and then refunded → 2 versions.

## Failed records
Normalisation failures mark the raw row `failed` with the error. They also raise the data-quality issue `raw_payload_processing_failed` (error severity), so nothing is silently dropped. The Shopify checkpoint stops before the first failed order, so it is re-read on the next run.

## Safe re-processing
New Edge Function **`reprocess-raw`** (cron secret or workspace owner/admin): it replays failed rows oldest first through the **same** pipeline the syncs and webhooks use, then refreshes reconciliation and quality. Processing is upsert-based, so replaying twice cannot duplicate anything. Viewers get 403.

## Sensitive data (deliberate trade-off)
Customer contact data already lives once in `commerce_customer`. Storing it again in every raw version would multiply copies, so `redactPii()` removes it before storage:
- removed: `email`, `phone`, `contact`, names, `address1/2`, `zip`, coordinates, `browser_ip`, `note`, `vpa`, whole `billing/shipping/default_address`, `addresses`, `client_details`, `card`, `bank_account`; Razorpay `notes` keep only order-reference keys;
- kept: all ids (incl. `customer.id`), amounts, currencies, statuses, line items, discounts, refunds, timestamps;
- the key stays with the value `[redacted]`, so "field present" vs "absent" is still visible.

Consequence: re-processing restores orders, payments and refunds completely. It **looks up** the customer instead of re-writing it, so stored customer details are never blanked (tested).

Not changed: `integrations_webhookevent.raw_body` still stores the full signed webhook body, PII included (existing behaviour; needed to prove what was received). Recommendation: a retention window for it (needs your approval — the rules forbid deleting data unasked).

## Workspace isolation
`integrations_rawpayload` keeps its existing policy (owner/admin/analyst of the workspace may read); the dedupe table is service-role only. Tested: another workspace reads 0 rows, and users cannot call `ingest_raw_payload`.

## Evidence
`tests/db/data_ingestion.test.ts` — 12 steps, all pass (see PHASE_3_TEST_REPORT.md). Live: 0 raw rows today (no code wrote them before Phase 3).
