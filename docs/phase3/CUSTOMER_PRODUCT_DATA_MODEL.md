# CUSTOMER_PRODUCT_DATA_MODEL — Phase 3

## Customers — `commerce_customer` (existing) + view `commerce_customer_metrics` ★
| Required | Where |
|---|---|
| Internal customer ID | `commerce_customer.id` |
| Workspace ID | `workspace_id`, `brand_id` |
| Shopify customer ID | `provider_id` (`provider='shopify'`), unique per brand |
| Email reference | `email` — stored once, here only (raw payloads are redacted) |
| Customer creation date | `source_created_at` |
| First / latest order date | view: `first_order_at`, `latest_order_at` |
| Order count | view: `order_count` (excludes voided and cancelled) |
| Lifetime order value | view: `lifetime_value_minor` = Σ(order total − refunded); `currencies` > 1 warns that values are mixed |

The view is computed from our own orders (security-invoker, so RLS applies). It doesn't trust Shopify's `orders_count`/`total_spent` (those columns are kept but are platform values).

**No automatic merging.** Customers are identified by the platform customer id only. Two customers with the same email are reported as `customer_shared_email` (info) and left separate; names are never used.

**Access control:** members of the brand's workspace can read customers (existing RLS). Raw payloads never carry contact data. Another workspace sees nothing (tested).

## Products — `commerce_product` + `commerce_productvariant` (existing)
| Required | Column |
|---|---|
| Internal product ID | `commerce_product.id` |
| Workspace ID | `workspace_id`, `brand_id` |
| Shopify product ID | `commerce_product.provider_id` |
| Variant ID | `commerce_productvariant.provider_id` (internal `id`) |
| SKU | `commerce_productvariant.sku` (also on order lines) |
| Product name | `commerce_product.title` (+ variant `title`) |
| Price | `commerce_productvariant.price_minor` |
| Currency | brand currency (`tenancy_brand.currency`) — Shopify variant prices are in the shop currency |
| Inventory reference | `inventory_quantity` |

Order lines now keep `provider_product_id` / `provider_variant_id` ★. Reconciliation links them to `commerce_productvariant` by exact id (tested); lines whose variant is unknown stay unlinked and are counted.

⚠ **No product sync exists**, so live product tables are empty and every live order line is unlinked (3/3). A Shopify products sync is a connector task (Phase 2).
