# MARKETING_DATA_MODEL — Phase 3 (Meta Ads, Instagram, Google Analytics 4)

Paid, organic and web-analytics data are kept in **separate tables** with their platforms' own definitions. All metric columns are **NULLable: NULL = not returned by the platform, 0 = reported zero.**

## Meta Ads — `analytics_meta_ad_daily` ★ (ad level, one row per ad per day per attribution setting)
| Required | Column |
|---|---|
| Campaign / ad set / ad id + names | `campaign_id`, `campaign_name`, `adset_id`, `adset_name`, `ad_id`, `ad_name` |
| Spend | `spend_minor` (+ `currency`) |
| Impressions, reach, clicks | `impressions`, `reach`, `clicks` |
| CPM, CPC, CTR | as reported by Meta: `meta_cpm`, `meta_cpc`, `meta_ctr` (percent). Computed alternatives in the view `analytics_meta_ad_daily_metrics` (`cpm`, `cpc`, `ctr_pct`) |
| Conversions | `purchases` (max over overlapping purchase action types) |
| Purchase value | `purchase_value_minor` |
| ROAS | view: `purchase_value / spend`, NULL when spend is 0/NULL |
| Reporting date | `report_date` |
| Attribution settings | `attribution_setting` (part of the unique key) |
| Original values | `source_metrics` JSONB (untouched `actions` / `action_values` etc.) |

Updates: Meta restates conversions for about 72 hours. A re-fetch **upserts** the same key (`fetched_at` updated), and every distinct fetch is also kept in the raw layer, which gives historical snapshots. The existing account-level `analytics_factadsdaily` (used by the dashboard today) is unchanged.

## Instagram (organic) — `analytics_instagram_media` ★ + `analytics_instagram_media_snapshot` ★
Media: `ig_account_id`, `media_id`, `media_type`, `media_product_type`, `permalink`, `published_at`.
Snapshot (per media per day; Instagram insights are lifetime counters): `reach`, `impressions` (NULL where Meta no longer reports it), `views`, `likes`, `comments`, `shares`, `saves`, `total_interactions`, `source_metrics`. Engagement rate is derived, never stored.

## GA4 — `analytics_ga4_daily` ★ + `analytics_ga4_transaction` ★
Daily: `report_date`, `session_source`, `session_medium`, `session_campaign`, `landing_page`, `device_category` (verbatim, incl. `(not set)`); `sessions`, `total_users`, `new_users`, `screen_page_views`, `key_events`, `transactions`, `purchase_revenue_minor`, `currency`.
Transactions: `transaction_id` + session source/medium/campaign + revenue. These are used to attribute Shopify orders (reconciliation `order_attribution`).
Rules: sessions are not customers or orders. **`total_users` must not be summed across rows** (GA4 de-duplicates users per query). Re-query GA4 for a different grouping instead.

## Implementation status
| | Schema | Normaliser + unit tests | Connector writes it |
|---|---|---|---|
| Meta ad level | ✅ | ✅ | ❌ `meta-ads-sync` requests `level=account` only |
| Instagram media + snapshots | ✅ | ✅ | ❌ `instagram-sync` checks account health only |
| GA4 daily + transactions | ✅ | ✅ | ❌ no GA4 integration exists |

Wiring these changes working integrations or adds connectors, so it needs your decision. Live Meta/Instagram tokens are currently rejected anyway.
