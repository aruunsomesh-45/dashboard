# SHIPPING_DATA_MODEL — Phase 3

Tables: **`commerce_shipment`** (existing + 5 columns, status set widened), **`commerce_trackingevent`** (existing + 4 columns, append-only), link **`commerce_ordershipmentlink`**.

| Required field | Column |
|---|---|
| Internal shipment ID | `id` |
| Workspace ID | `workspace_id`, `brand_id` |
| Internal order ID | via `commerce_ordershipmentlink` (exact courier order reference) |
| Delhivery waybill | `awb` (= `provider_id`) |
| Courier name | `courier_name` |
| Shipment status | `canonical_status` + `raw_status` |
| Pickup timestamp | `picked_up_at` ★ (Delhivery `PickUpDate`, else first picked-up scan) |
| Dispatch timestamp | `shipped_at` (first in-transit scan) |
| Delivery timestamp | `delivered_at` |
| Return status | `return_status` ★ (rto_initiated / rto_in_transit / rto_delivered / returned) |
| Last tracking update | `last_tracking_at` ★ |
| Source reference | `provider`, `provider_id`, `order_ref` ★ (Delhivery `ReferenceNo`), `payment_mode` ★ (prepaid/cod) |

## Statuses
`created, pickup_pending, picked_up★, in_transit, out_for_delivery, delivered, ndr (failed delivery), rto_initiated, rto_in_transit★, rto_delivered, returned★, cancelled, unknown★`. The CHECK was widened (superset); no existing value was removed. Mapping table: DATA_NORMALIZATION_REPORT.md.

## Event history (never overwritten)
`commerce_trackingevent` gets one row per courier scan: `occurred_at` (UTC), `location`, `status_description`, `raw_status` ★, `source_code` ★, `canonical_status` ★, `ingested_at` ★. Unique `(shipment_id, occurred_at, raw_status, location)`, so re-fetching the same scans adds nothing, and a new scan is appended. The shipment row holds only the latest state plus milestone timestamps derived from the scans. `ndr_count` = number of failed-delivery scans.

## Status of implementation
| Part | State |
|---|---|
| Schema | ✅ in migration 20261124000000 |
| `mapDelhiveryShipment` normaliser (IST → UTC, ordered scans, milestones) | ✅ unit-tested with a synthetic response |
| Order ↔ shipment reconciliation | ✅ tested (MATCHED / UNMATCHED / no-reference) |
| Delhivery connector (API sync / webhook) | ❌ not built — needs your decision + a Delhivery API token |
| Verification against a real Delhivery response | ❌ not possible yet |
