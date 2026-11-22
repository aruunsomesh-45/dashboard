# Live API Integration Report (Phase 7)

*2026-11-21. Credentials were taken **only** from the application's own secure store: the four rows of `integrations_integration` in the hosted DB, decrypted in memory by the application's own `decryptCredentials`, and passed to the application's own `test-connection` handler. Calls were **read-only GETs**. No credential or response body containing personal data was printed or stored. `serverless/.env` contains no provider credentials (all `SHOPIFY_*`, `RAZORPAY_KEY_*`, `META_*`, `INSTAGRAM_*` are empty).*

## 1. Classification summary

| Provider | MOCKED | SANDBOX | LIVE | Live outcome |
|---|---|---|---|---|
| Shopify | ✓ (sync, pagination, 401, 429, timeout, malformed JSON, foreign-host Link) | — | **attempted, not sent** | stored "access token" is a `shpss_` **API secret**, not an Admin API token (`shpat_`); the app's validator refused before calling Shopify |
| Razorpay | ✓ (Basic auth, count/skip pagination, 401, validation) | — | **✓ called** | `GET /v1/payments?count=1` → **HTTP 401 Authentication failed** |
| Meta Ads | ✓ (paging, code 190, code 200, foreign host) | — | **✓ called** | `GET graph.facebook.com/v21.0/act_…` → **HTTP 400 token_invalid ("Cannot parse access token")** |
| Instagram | ✓ (full / partial permissions, invalid token) | — | **✓ called** | Graph `GET /me…` → **HTTP 400 token_invalid** |

**No provider is live-verified as working.** Every stored credential on the hosted DB is invalid or the wrong type. The app's own sync history agrees: all 5 recorded sync runs (2026-11-20 14:55 → 2026-11-21 07:53 UTC) **failed** with the same provider messages, all 4 integrations are in status `error`, and `last_synced_at` is NULL for all of them.

## 2. Live call log (redacted)

| Time (UTC) | Provider | Endpoint | Upstream status | Function status | Latency | Validation | Persisted |
|---|---|---|---|---|---|---|---|
| 2026-11-21 08:56:12.771 | Instagram | Graph API (identity) | 400 | 200 (`connection_status: failed`) | 275 ms | error parsed into `token_invalid` | no (read-only probe) |
| 2026-11-21 08:56:13.053 | Meta Ads | `GET /v21.0/act_<id>` | 400 | 200 (`failed`) | 218 ms | `token_invalid` | no |
| 2026-11-21 08:56:13.272 | Razorpay | `GET /v1/payments?count=1` | 401 | 200 (`failed`) | 140 ms | `Authentication failed` | no |
| 2026-11-21 08:56:13.414 | Shopify | — (blocked locally) | — | 200 (`failed`, http 400) | 0 ms | "You entered the API Secret Key (shpss_…)" | no |

Credential field names present (values never shown): Shopify `access_token, api_secret, shop_domain`; Razorpay `key_id, key_secret, webhook_secret`; Meta `access_token, ad_account_id`; Instagram `access_token, instagram_id`.

## 3. Test matrix by provider

### Shopify
| Test | Result |
|---|---|
| Credential validation | LIVE: rejected locally (wrong token type). MOCKED: 401 → 502 + integration `error` ✓ |
| Store connection / identity (`/shop.json`) | **BLOCKED** (needs a valid `shpat_` token with `read_orders`, `read_products`, `read_customers`, `read_inventory`) |
| Products / variants / inventory fetching | **NOT IMPLEMENTED** in either sync: the Edge function calls only `orders.json` (customers and lines come embedded); Django `shopify/sync.py` likewise ingests orders only. `commerce_product` / `commerce_productvariant` tables exist but nothing fills them |
| Orders, customers, pagination, rate limit, invalid responses, persistence, incremental sync, duplicate prevention | MOCKED ✓ (`functions_sync.test.ts`) — LIVE BLOCKED |

### Razorpay
| Test | Result |
|---|---|
| Credential validation | LIVE ✓ executed → **401 (invalid key pair)** |
| Payment fetching, normalisation, failed payments, duplicate prevention | MOCKED ✓ — LIVE BLOCKED |
| Refunds | **PARTIAL**: a refunded payment is normalised to status `refunded` (`razorpay/adapter.py`); refund entities, amounts and partial refunds are not modelled, and refunds don't reduce sales metrics |
| Order/payment mapping | MOCKED ✓ (Django `OrderPaymentLink`) |
| Webhook signature | ✓ (see webhook report) |

### Meta Ads
| Test | Result |
|---|---|
| Token validation | LIVE ✓ executed → **400 token_invalid** |
| Ad accounts, campaigns, ad sets, ads | campaigns via Django `meta_ads/sync.py` (MOCKED); **ad-set / ad-level fetch not implemented** in Edge sync |
| Daily insights, date range, pagination, token expiry (190), permission (200), normalisation, persistence | MOCKED ✓ — LIVE BLOCKED |

### Instagram
| Test | Result |
|---|---|
| Account connection / identity | LIVE ✓ executed → **400 token_invalid** |
| Permissions (partial), unsupported permission reporting, error handling | MOCKED ✓ |
| Media / insights | MOCKED ✓ — LIVE BLOCKED |

## 4. Steps to complete live verification

1. In the app (Integrations), re-enter valid credentials:
   - **Shopify:** Admin API **access token** `shpat_…` (Shopify admin → Apps → Develop apps → API credentials → Admin API access token). Not the `shpss_` API secret, which belongs only in the webhook secret field.
   - **Razorpay:** a `rzp_test_…` key id + secret pair (test mode recommended) and the webhook secret.
   - **Meta:** a system-user token with `ads_read` for the ad account.
   - **Instagram:** a token with `instagram_basic`, `pages_show_list`, `instagram_manage_insights`.
2. Run the live suite against an isolated DB (never writes to the hosted project):
   ```
   cd serverless
   set LIVE_SHOPIFY_SHOP=…  LIVE_SHOPIFY_TOKEN=…  LIVE_RAZORPAY_KEY_ID=…  LIVE_RAZORPAY_KEY_SECRET=…
   set LIVE_META_AD_ACCOUNT=…  LIVE_META_TOKEN=…  LIVE_INSTAGRAM_TOKEN=…
   deno task test:live
   ```
   Each provider asserts (1) auth, (2) data fetch, (3) persistence + no duplicates on re-run.
3. Then trigger a sync from the UI and compare `integrations_syncrun` counts with the provider dashboards.
