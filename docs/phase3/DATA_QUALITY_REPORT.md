# DATA_QUALITY_REPORT — Phase 3

Engine: `public.run_data_quality_checks(brand_id) → jsonb summary` (service role only; hourly via `run_data_pipeline_maintenance()`, and after `reprocess-raw`). Results go to `data_quality_issue`: one row per (check, record), with severity, message, details, `first_seen_at`, `last_seen_at`, `resolved_at`.

**It never edits or deletes the offending data** (tested: record counts and values unchanged). An issue that is no longer found gets `resolved_at` and is kept as history. If the problem comes back, the same row re-opens.

## Checks
| Area | check_key | Severity |
|---|---|---|
| Missing required fields | order_missing_number, order_missing_created_at, payment_missing_created_at | error |
| | captured_payment_zero_amount | warning |
| Invalid currency | order_invalid_currency, payment_invalid_currency | error |
| Invalid timestamps | order_timestamp_out_of_range (future, < 2000, updated before created) | error |
| Negative / inconsistent amounts | order_negative_net_sales, order_refund_exceeds_total, payment_refund_exceeds_amount | error |
| | order_total_inconsistent (total ≠ subtotal + shipping [+ tax if not included], ±1 paisa) | warning |
| Conflicting statuses | order_refunded_without_refund_amount, order_cancelled_but_paid, order_cancelled_but_fulfilled, payment_unknown_source_status, shipment_unknown_status, shipment_delivered_without_timestamp | warning |
| Invalid foreign keys (pointing into another brand) | cross_brand_customer_reference, cross_brand_payment_link, cross_brand_shipment_link, cross_brand_variant_reference | error |
| Orphaned records | refund_orphaned | warning |
| Duplicates (reported, never merged) | customer_shared_email | info |
| Payment reconciliation | payment_reconciliation_needs_review / _unmatched (captured only), order_payment_* | warning / info |
| Shipment reconciliation | shipment_unmatched / shipment_needs_review | warning |
| Refund sources disagree | refund_source_mismatch (Shopify vs Razorpay refund totals) | warning |
| Ingestion failures | raw_payload_processing_failed | error |
| Incorrect aggregation | fact_shop_daily_mismatch (stored daily fact ≠ recomputation with the same local-date rule) | error |

Duplicate canonical records can't exist: the `(brand_id, provider, provider_id)` unique constraints prevent them.

## Results
**Synthetic (PGlite):** 13 seeded defects → 13 issues with the expected keys and severities; the consistent control order raised none; another brand raised none; fix → resolved; re-break → re-opened.

**Live production — read-only counts of the checks that work on existing columns (2026-11-23):**

| Check | Live count |
|---|---|
| order/payment invalid currency | 0 / 0 |
| order missing number / created_at | 0 / 0 |
| order timestamp out of range | 0 |
| negative net sales | 0 |
| cancelled-but-paid / cancelled-but-fulfilled | 0 / 0 |
| payment missing timestamp / captured with zero amount | 0 / 0 |
| cross-brand customer reference | 0 |
| customers sharing an email | 0 |
| *Population* | 3 orders, 2 payments (test data from 20–21 Nov) |

Checks that need Phase 3 columns (refunds, subtotal, reconciliation, raw failures) can't run live until the migration is applied. **Caveat:** 3 orders is far too few for these zeros to say anything about data quality at real volume.
