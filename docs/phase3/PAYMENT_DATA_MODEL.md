# PAYMENT_DATA_MODEL — Phase 3

Tables: **`commerce_paymentattempt`** (existing + 5 columns), **`commerce_refund`** ★, link **`commerce_orderpaymentlink`** (existing).

| Required field | Column |
|---|---|
| Internal payment ID | `id` |
| Workspace ID | `workspace_id`, `brand_id` |
| Internal order ID | via `commerce_orderpaymentlink.order_id` (many-to-many: several payments per order are allowed) |
| Razorpay payment ID | `provider_id` (`pay_…`) |
| Amount / currency | `amount_minor` (paise), `currency` |
| Payment status | `status` (canonical) + `source_status` ★ (as Razorpay sent it) |
| Method | `method` (upi, card, netbanking, wallet, emi, other) |
| Payment timestamp | `source_created_at` (UTC from epoch) |
| Refund amount / status | `refunded_amount_minor` ★ (Razorpay `amount_refunded`, NULL if absent), `refund_status` ★ (partial / full) |
| Payment reference | `gateway_order_id` (Razorpay `order_…`), `merchant_order_ref` ★ + `merchant_order_ref_key` ★ (from `notes`) |
| Source payload reference | raw row `integrations_rawpayload` (`provider='razorpay'`, `entity_id=pay_…`) |

**`commerce_refund` ★** — one row per refund: `provider_id` (`rfnd_…` or Shopify refund id), `amount_minor`, `currency`, `status` (pending / processed / failed) + `source_status`, `payment_provider_id` → `payment_attempt_id`, `order_provider_id` → `order_id`, `source_created_at`, `raw_payload_ref`. Unique `(brand_id, provider, provider_id)`, so multiple refunds per payment are supported and a resent webhook can't duplicate one.

## Requirements
| Requirement | How |
|---|---|
| Multiple payments per order | link table, unique `(order_id, payment_attempt_id)` |
| Partial payments | order-level reconciliation reports `PARTIALLY_MATCHED` with captured vs total |
| Failed payments | stored with `status='failed'`, error code/description; linked if they carry the order ref; never counted as captured |
| Refunds / multiple refunds | `commerce_refund` rows from the `refund.*` webhook; payment refund fields updated from the same event |
| Reliable reconciliation | links only from an exact order id/number in `notes` (keys: shopify_order_id, shopify_order_number, shopify_order_name, merchant_order_id, order_id, order_number, receipt; value must look like an id) |
| Unknown orders | a payment without a reliable reference stays **UNMATCHED** or **NEEDS_REVIEW** with candidates; it is never attached by amount |
| No double counting | captured totals are computed per order from linked payments; an order whose captured sum exceeds its total is flagged `NEEDS_REVIEW` (possible double payment), not added twice |

⚠ Which `notes` keys your Shopify→Razorpay checkout actually sends has **not** been verified: no live payment carries notes yet (all live credentials are invalid). Until confirmed, expect `NEEDS_REVIEW`/`UNMATCHED` rather than automatic links.
