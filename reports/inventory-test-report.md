# Inventory Test Report (Phase 10)

*2026-11-21.*

## Verdict: **NOT IMPLEMENTED: all functional checks BLOCKED**

The inventory feature consists of one static page (`frontend/src/app/inventory/page.tsx`) behind a module flag. Searching `backend/apps`, `serverless/supabase`, `supabase/migrations` and the frontend found:

| Expected component | Present? |
|---|---|
| Product / variant sync from Shopify | **No.** Tables `commerce_product`, `commerce_productvariant` exist (hosted DB: 0 rows); no code fills them (Edge and Django Shopify syncs call only `orders.json`) |
| SKU / inventory-item / location mapping | No |
| Available / committed / incoming quantities | No columns, no API |
| Low-stock thresholds, out-of-stock alerts | No (the alerts engine has no inventory rule) |
| Stock movements / history | No |
| Inventory dashboard API | No |
| Shopify `inventory_levels/*` webhooks | No (webhook handlers process `orders/*` only) |
| Failed-sync recovery | n/a |

## Test results

| Check | Result |
|---|---|
| Product & variant synchronisation | BLOCKED: not implemented |
| SKU / inventory item / location mapping | BLOCKED: not implemented |
| Available / committed / incoming quantity | BLOCKED: not implemented |
| Low-stock thresholds, out-of-stock alerts | BLOCKED: not implemented |
| Stock movements, history | BLOCKED: not implemented |
| Dashboard calculations | BLOCKED: not implemented |
| Duplicate prevention | BLOCKED: not implemented |
| Shopify inventory webhooks | BLOCKED: not implemented |
| Failed sync recovery | BLOCKED: not implemented |
| Shopify as source of truth | n/a: nothing is mirrored; no writes to Shopify inventory exist (✓ no risk of modifying real stock) |
| Page loads for an authorised user | PASS: renders inside the shell; module guard respected |

## Defect found and fixed

**P1-8: fabricated metrics.** The page showed hardcoded numbers (Total SKUs 128, "94 % in stock", 4 low-stock, 2 out of stock) and stated *"Real-time multi-location stock synchronization is running for your workspace."* None of that was true. They were replaced with "—" values and an explicit notice: *"Stock levels are not synchronised from Shopify in this version. Nothing on this page reflects your real inventory."*

## To build (outline)

1. Shopify scopes `read_products`, `read_inventory`, `read_locations`.
2. Sync `products.json` (paginated) → `commerce_product` / `commerce_productvariant` (store `inventory_item_id`, SKU).
3. Sync `inventory_levels.json?location_ids=…` into a new `commerce_inventorylevel(brand_id, inventory_item_id, location_id, available, committed, incoming, updated_at)` with a unique `(brand_id, inventory_item_id, location_id)` key, plus RLS identical to the other commerce tables.
4. Register the `inventory_levels/update` and `products/update` webhooks through the existing HMAC pipeline.
5. Threshold columns + an alerts rule; a read API; tests mirroring `functions_sync.test.ts`.
