# DATA_RECONCILIATION_REPORT — Phase 3

Engine: `public.reconcile_brand(brand_id) → jsonb summary` (service role only). It runs hourly through `run_data_pipeline_maintenance()` (pg_cron, once enabled) and after every `reprocess-raw` call. Results: `commerce_reconciliation` (one row per entity: status, matched order, method, confidence, details with the reason and candidates). Links: existing `commerce_orderpaymentlink` / `commerce_ordershipmentlink`.

**Principle: links are created only from exact identifiers.** Look-alikes (same amount, close in time) are reported as `NEEDS_REVIEW` with candidates and are never linked.

| # | Match | Reliable identifier | Auto-link | Statuses |
|---|---|---|---|---|
| 1 | Payment → order | Shopify order id (conf 1.00) or order number/name (0.95) in Razorpay `notes`, naming exactly one order in the same brand | yes | MATCHED · NEEDS_REVIEW (ambiguous ref, >1 link, or amount+time candidate) · UNMATCHED |
| 1b | Order → payments (completeness) | sum of captured linked payments vs order total; only orders whose gateway list contains Razorpay | — | MATCHED (equal) · PARTIALLY_MATCHED (less) · NEEDS_REVIEW (more = possible double payment, or currency mismatch) · UNMATCHED |
| 2 | Shipment → order | courier order reference (`ReferenceNo`) = order id/number/name | yes | MATCHED · NEEDS_REVIEW (ambiguous) · UNMATCHED (with reason) |
| 3 | Refund → payment / order | Razorpay `payment_id`; Shopify refund's order id; order via the payment's single link | yes | MATCHED · PARTIALLY_MATCHED (payment known, order not) · NEEDS_REVIEW (refund > payment) · UNMATCHED |
| 4 | Customer reference | platform customer id only | — | cross-brand references raised by data quality |
| 5 | Product reference | order line `provider_variant_id` = variant `provider_id` | yes | unlinked lines counted in the summary |
| 6 | Attribution | GA4 `transactionId` = order id/number/name | — | MATCHED · NEEDS_REVIEW (several) · PARTIALLY_MATCHED (order UTM only) · UNMATCHED |
| 7 | Unmatched reporting | `commerce_reconciliation` rows + `data_quality_issue` (payment/order/shipment mismatches) | — | — |

Safety properties (all tested):
- brand-scoped: identical order numbers in another brand are never matched;
- idempotent: a second run creates no links, and rows whose result didn't change are not rewritten;
- failed payment attempts are traced to their order but never counted as captured;
- COD / non-Razorpay orders are excluded from payment completeness.

## Synthetic test scenario (PGlite, not production data)
| Case | Result |
|---|---|
| Payment with order id in notes | MATCHED 1.00 |
| Payment with `#1002` | MATCHED 0.95 |
| Same amount, +5 min, no reference | NEEDS_REVIEW, candidate listed, **no link** |
| Reference matching two orders | NEEDS_REVIEW `ambiguous_order_ref`, no link |
| No reference, no candidate | UNMATCHED |
| Order total 1180, captured 1180 (+1 failed attempt) | MATCHED, failed_attempts 1 |
| Order 500, captured 200 | PARTIALLY_MATCHED |
| Order 100, two captured payments of 100 | NEEDS_REVIEW "exceeds order total" |
| Shipment `#1001` / unknown ref / no ref | MATCHED / UNMATCHED / UNMATCHED ("no order reference") |
| Refunds: known payment / unknown payment / Shopify refund / over-refund | MATCHED / UNMATCHED / MATCHED / NEEDS_REVIEW |
| GA4 transaction 1001 / UTM only / none | MATCHED / PARTIALLY_MATCHED / UNMATCHED |

## Live state
Not run against production (the migration isn't applied). Live data today: 3 orders and 2 payments, all from Nov 20–21 tests, 0 links. Their payments carry no notes, so they would be UNMATCHED or NEEDS_REVIEW, as they should be.

## Open question for you
Confirm which `notes` keys your Razorpay checkout (Shopify app) writes. If it writes none, the only reliable bridge is Shopify's transaction `authorization` (= Razorpay `pay_…`). Fetching Shopify transactions is a connector change (extra API calls), so it needs your OK.
