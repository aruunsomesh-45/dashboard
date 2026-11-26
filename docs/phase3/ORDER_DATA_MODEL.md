# ORDER_DATA_MODEL — Phase 3

Table **`commerce_order`** (existing; Phase 3 adds columns only) + `commerce_orderline`, `commerce_order_history` ★, `commerce_refund` ★.

| Required field | Column | Notes |
|---|---|---|
| Internal order ID | `id` UUID | |
| Workspace ID | `workspace_id` (+ `brand_id`) | RLS by brand |
| Shopify order ID | `provider_id` (with `provider='shopify'`) | unique per brand |
| Order number | `order_number` | Shopify `order_number` (e.g. `1001`; name `#1001` matches too) |
| Customer reference | `customer_id → commerce_customer` | by Shopify customer id only |
| Created / updated | `source_created_at`, `source_updated_at` (UTC) | |
| Currency | `currency` CHAR(3) | |
| Subtotal | `subtotal_amount` ★ | NULL if not provided |
| Discount | `discount_amount` | |
| Tax | `tax_amount` (+ `taxes_included` ★) | |
| Shipping | `shipping_amount` | sum of shipping lines |
| Total | `gross_amount` | **= Shopify `total_price`** (existing name kept so the dashboard is unchanged) |
| Financial status | `financial_status` (canonical) + `source_financial_status` ★ | |
| Fulfilment status | `fulfillment_status` + `source_fulfillment_status` ★ | |
| Refund amount | `refunded_amount` ★ | successful refund transactions; NULL = no refund data, 0 = none |
| Source platform | `provider`, `source_name` ★ (web, pos, …) | |
| Original source reference | `raw_payload_ref` → `integrations_rawpayload.id` | now filled |
| Cancellation | `cancelled_at`, `cancel_reason` ★ | |
| Payment gateways | `payment_gateways TEXT[]` ★ | scopes payment reconciliation |
| Attribution | `utm_source/medium/campaign`, `landing_path`, `referring_domain` ★ | |

`net_sales = total − tax − shipping` (existing definition, unchanged).

## Requirements
| # | Requirement | How |
|---|---|---|
| 1 | One canonical record per order | `UNIQUE (brand_id, provider, provider_id)`; sync and webhook share one pipeline |
| 2 | No duplicates | upsert on that key; raw re-fetches deduplicated by hash |
| 3 | Updates | `updated_at`-based incremental sync + `orders/updated` webhook |
| 4 | Cancellations | `cancelled_at`, `cancel_reason`; voided excluded from facts |
| 5 | Partial refunds | `commerce_refund` rows (one per Shopify refund) + `refunded_amount` total |
| 6 | History | `commerce_order_history` ★ written by trigger on insert and on any change to status / amounts / refunds / cancellation (tested: created → updated/refunded; unchanged re-sync writes nothing) |
| 7 | Historical imports | `days` = backfill window (≤365) without moving the checkpoint backwards; `source='backfill'` on raw rows |

**Payments are never orders**: payments live in `commerce_paymentattempt` and connect only through `commerce_orderpaymentlink`. Order revenue is computed from orders only. Refunds: use `commerce_order.refunded_amount` (Shopify) for revenue. Razorpay refunds are for cash reconciliation only — adding both would double-count (data quality check `refund_source_mismatch`).

Order lines: replaced as a set on every update (no natural key at the line level), with `provider_line_id/product_id/variant_id` ★ for product matching.
