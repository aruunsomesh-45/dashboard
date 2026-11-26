# DATA_NORMALIZATION_REPORT — Phase 3

All normalisers are pure functions in `serverless/supabase/functions/_shared/mappers.ts`. They run through one pipeline per entity (`_shared/pipeline.ts`), shared by syncs, webhooks and re-processing.

## Rules
| Concern | Rule | Implementation |
|---|---|---|
| Record IDs | internal `UUID`; platform id kept as `provider_id` (string); unique `(brand_id, provider, provider_id)` | all canonical tables |
| Money | integer minor units (`BIGINT`, paise); decimal strings parsed without floats, half-up | `toMinor`, `toMinorOrNull` |
| Missing vs zero | new columns are **NULL when the platform did not provide the value**; `0` only when it reported zero | `toMinorOrNull`, `intOrNull`, `decimalOrNull` |
| Currency | explicit ISO-4217 column; upper-cased; invalid values kept visible and flagged by data quality (never silently "fixed") | `normalizeCurrency`; CHECK `^[A-Z]{3}$` on new tables |
| Timestamps | `TIMESTAMPTZ`, UTC; offset-less courier times interpreted as IST (`+05:30`) | `isoOrNull`, `localToUtcIso` |
| Reporting dates | computed in the brand's timezone (`tenancy_brand.timezone`) — fixed bug D1 | `refresh_daily_fact_shop`, quality check |
| Statuses | canonical value for the dashboard **and** the original value preserved | `source_financial_status`, `source_fulfillment_status`, `source_status` |
| Customers | Shopify customer id only; never matched by name/email | `mapShopifyCustomer` |
| Products | order lines keep `provider_product_id` / `provider_variant_id`; linked to variants by exact id | reconciliation (f) |
| Campaigns | Meta campaign / ad set / ad ids + names per row | `mapMetaAdInsightDay` |
| Source / medium | UTM from the landing URL (trimmed, lower-cased); only path + 3 UTM params kept (other query params can hold PII); referrer → domain | `parseAttribution` |
| Platform ids | provider name + id on every row | — |

## Status mappings
**Shopify financial → canonical (unchanged), original kept**
| Shopify | canonical |
|---|---|
| pending, authorized, partially_paid | pending |
| paid | paid |
| partially_refunded / refunded | same |
| voided, expired | voided |

**Razorpay payment** `created/authorized → authorized`, `captured`, `failed`, `refunded`; **unknown → `failed`** (existing behaviour, kept) **but** `source_status` keeps the real value and data quality raises `payment_unknown_source_status`.

**Razorpay refund** `pending/created → pending`, `processed`, `failed`.

**Delhivery (StatusType + text) → shipment canonical**
| Delhivery | canonical |
|---|---|
| Manifested, Not Picked, Pickup*, PP | pickup_pending |
| Picked Up, PU | picked_up |
| In Transit, Pending, Reached, Bagged | in_transit |
| Dispatched, Out for delivery | out_for_delivery |
| Undelivered / NDR | ndr (failed delivery) |
| DL Delivered | delivered |
| RT + initiated / in transit / delivered·returned | rto_initiated / rto_in_transit / rto_delivered |
| CN | cancelled |
| anything else | unknown (raw kept, flagged) |

⚠ Built from Delhivery's documented response shape; **no Delhivery connector exists**, so it has not been checked against a real response.

## Platform metric definitions (not unified)
- **Meta**: purchases = max over overlapping action types (`purchase`, `omni_purchase`, pixel purchase), never the sum. Meta's own CPM/CPC/CTR are stored as reported (`meta_*`). Our ratios are computed in the view `analytics_meta_ad_daily_metrics` and are NULL when the denominator is missing or zero. The attribution setting is part of the key.
- **Instagram**: lifetime counters, one snapshot per media per day. `impressions` is NULL for media where Meta no longer reports it. Both Graph insight shapes (`values[0]`, `total_value`) are handled.
- **GA4**: dimensions stored verbatim incl. `(not set)`. `keyEvents` (falls back to legacy `conversions`). **`total_users` is not additive across rows — never SUM it.** Sessions are not customers or orders.
- Paid (Meta) and organic (Instagram) data live in separate tables.

## Status of each source
| Source | Normaliser | Connector writes it | Evidence |
|---|---|---|---|
| Shopify orders / customers / lines / refunds | ✅ | ✅ sync + webhook (`orders/*`, new `refunds/create`) | unit + DB tests |
| Razorpay payments / refunds | ✅ | ✅ sync + webhook (new `refund.*`) | unit + DB tests |
| Delhivery shipments / scans | ✅ | ❌ no connector | unit tests only |
| Meta ad-level | ✅ | ❌ `meta-ads-sync` still writes account level only | unit tests only |
| Instagram media | ✅ | ❌ `instagram-sync` only checks account health | unit tests only |
| GA4 daily + transactions | ✅ | ❌ no connector | unit tests only |

Wiring the last four needs either new connectors (Phase 2 scope) or changes to working integrations — awaiting your decision.
