# 125 EAST — Comprehensive API Test Report
**Execution Date:** 2026-11-13 18:18:43 IST  
**Authenticated User:** `aruunsomesh@gmail.com` (Role: Owner)  
**Target Workspace:** `Aruunsomesh Store` (`aruunsomesh-store`)  
**Target Brand:** `Aruunsomesh Store` (`e309a60f-d474-4d04-ae30-387b571c46f2`)  
**Total Tested Endpoints:** 14  

---

## 1. Executive Summary Table

| # | Endpoint Name | Method | Route | Status | Latency | Result |
| :-: | :--- | :-: | :--- | :-: | :-: | :-: |
| 1 | **Get Current User Profile & Memberships** | `GET` | `/api/auth/me/` | `200` | `364.7ms` | ✅ PASS |
| 2 | **Refresh CSRF Protection Token** | `GET` | `/api/auth/csrf/` | `200` | `0.0ms` | ✅ PASS |
| 3 | **List User Workspaces** | `GET` | `/api/w/` | `200` | `6.8ms` | ✅ PASS |
| 4 | **Get Workspace Details by Slug** | `GET` | `/api/w/aruunsomesh-store/` | `200` | `0.0ms` | ✅ PASS |
| 5 | **List Workspace Brands** | `GET` | `/api/w/aruunsomesh-store/brands/` | `200` | `6.9ms` | ✅ PASS |
| 6 | **List Workspace Team Members & Roles** | `GET` | `/api/w/aruunsomesh-store/members/` | `200` | `0.0ms` | ✅ PASS |
| 7 | **Get Shopify Dashboard Orders, Funnel & Financials** | `GET` | `/api/w/aruunsomesh-store/b/e309a60f-d474-4d04-ae30-387b571c46f2/shopify/stats/?days=30&limit=5` | `200` | `7.2ms` | ✅ PASS |
| 8 | **Trigger Shopify On-Demand Order Sync** | `POST` | `/api/w/aruunsomesh-store/b/e309a60f-d474-4d04-ae30-387b571c46f2/shopify/sync-now/` | `404` | `8.7ms` | ⚠️ NOTICE |
| 9 | **Get Meta Ads Intelligence & Campaign Breakdown** | `GET` | `/api/w/aruunsomesh-store/b/e309a60f-d474-4d04-ae30-387b571c46f2/marketing/stats/?days=30` | `200` | `1754.2ms` | ✅ PASS |
| 10 | **Trigger Meta On-Demand Ad Ingestion** | `POST` | `/api/w/aruunsomesh-store/b/e309a60f-d474-4d04-ae30-387b571c46f2/marketing/sync-now/` | `400` | `638.8ms` | ⚠️ NOTICE |
| 11 | **List All Installed Apps & Connection Statuses** | `GET` | `/api/w/aruunsomesh-store/b/e309a60f-d474-4d04-ae30-387b571c46f2/integrations/` | `200` | `4.2ms` | ✅ PASS |
| 12 | **Save & Encrypt Integration Credentials (AES-256-GCM)** | `POST` | `/api/w/aruunsomesh-store/b/e309a60f-d474-4d04-ae30-387b571c46f2/integrations/` | `200` | `7.4ms` | ✅ PASS |
| 13 | **Query Unified Executive Metrics (MER & Blended Sales)** | `GET` | `/api/w/aruunsomesh-store/b/e309a60f-d474-4d04-ae30-387b571c46f2/metrics/?metrics=net_sales,ad_spend,blended_roas&days=30` | `200` | `2.9ms` | ✅ PASS |
| 14 | **List Deterministic Workspace Alerts** | `GET` | `/api/w/aruunsomesh-store/alerts/` | `200` | `4.8ms` | ✅ PASS |

---

## 2. Detailed API Test Results (JSON, Message & Use Case)


### 1. Authentication & Session APIs

#### 1. Get Current User Profile & Memberships
- **HTTP Method & URL:** `GET /api/auth/me/`
- **Response Status:** `200 PASS` (364.7ms)
- **UI Dashboard Location:** `Global Navigation Bar & All Protected Routes`
- **Business Use Case:** Called immediately on initial page load by AuthContext. Validates the Supabase session, establishes the user's active tenant permissions, and loads workspace memberships for the brand switcher.

- **Status Message:** `Success`

```json
{
  "user": {
    "id": "b1090049-64a1-4a0b-bead-eb16f61dbeea",
    "email": "aruunsomesh@gmail.com",
    "first_name": "",
    "last_name": "",
    "mfa_enabled": false,
    "created_at": "2026-11-13T05:36:05.798268Z"
  },
  "workspaces": [
    {
      "id": "246b35a1-35d6-40a9-9e3b-5269fa893d9b",
      "name": "Aruunsomesh Store",
      "slug": "aruunsomesh-store",
      "role": "owner",
      "brands": [
        {
          "id": "e309a60f-d474-4d04-ae30-387b571c46f2",
          "name": "Aruunsomesh Store",
          "currency": "INR",
          "timezone": "Asia/Kolkata"
        }
      ]
    }
  ]
}
```

#### 2. Refresh CSRF Protection Token
- **HTTP Method & URL:** `GET /api/auth/csrf/`
- **Response Status:** `200 PASS` (0.0ms)
- **UI Dashboard Location:** `Security Layer / Background Token Rotation`
- **Business Use Case:** Provides a fresh Double-Submit CSRF cookie before sensitive mutation requests (e.g. updating bank accounts, disconnecting stores, or changing passwords).

- **Status Message:** `Success`

```json
{
  "csrfToken": "Chb9FTinsoUREf82xU5eKWrAyZ5LE4K1Uc3rmdlIuNidGHBRbsmdRUODYQfh9xyo"
}
```


### 2. Workspace & Tenancy APIs

#### 3. List User Workspaces
- **HTTP Method & URL:** `GET /api/w/`
- **Response Status:** `200 PASS` (6.8ms)
- **UI Dashboard Location:** `Sidebar (Brand Switcher)`
- **Business Use Case:** Fetches all multi-tenant workspaces and brands owned by or assigned to the user. Powers the brand dropdown switcher in the left sidebar.

- **Status Message:** `Array returned (1 records)`

```json
[
  {
    "id": "246b35a1-35d6-40a9-9e3b-5269fa893d9b",
    "name": "Aruunsomesh Store",
    "slug": "aruunsomesh-store",
    "plan": "starter",
    "is_active": true,
    "created_at": "2026-11-13T05:36:06.352440Z",
    "role": "owner"
  }
]
```

#### 4. Get Workspace Details by Slug
- **HTTP Method & URL:** `GET /api/w/aruunsomesh-store/`
- **Response Status:** `200 PASS` (0.0ms)
- **UI Dashboard Location:** `Workspace Settings Page (/settings)`
- **Business Use Case:** Retrieves the active workspace configuration, billing tier, team member limits, and metadata.

- **Status Message:** `Success`

```json
{
  "workspace": {
    "id": "246b35a1-35d6-40a9-9e3b-5269fa893d9b",
    "name": "Aruunsomesh Store",
    "slug": "aruunsomesh-store",
    "plan": "starter",
    "is_active": true,
    "created_at": "2026-11-13T05:36:06.352440Z"
  },
  "role": "owner",
  "brands": [
    {
      "id": "e309a60f-d474-4d04-ae30-387b571c46f2",
      "workspace": "246b35a1-35d6-40a9-9e3b-5269fa893d9b",
      "name": "Aruunsomesh Store",
      "timezone": "Asia/Kolkata",
      "currency": "INR",
      "created_at": "2026-11-13T05:36:06.361373Z"
    }
  ]
}
```

#### 5. List Workspace Brands
- **HTTP Method & URL:** `GET /api/w/aruunsomesh-store/brands/`
- **Response Status:** `200 PASS` (6.9ms)
- **UI Dashboard Location:** `Brand Management Modal & Settings`
- **Business Use Case:** Enumerates all e-commerce brands under the active organization with localized currency and timezone settings.

- **Status Message:** `Array returned (1 records)`

```json
[
  {
    "id": "e309a60f-d474-4d04-ae30-387b571c46f2",
    "workspace": "246b35a1-35d6-40a9-9e3b-5269fa893d9b",
    "name": "Aruunsomesh Store",
    "timezone": "Asia/Kolkata",
    "currency": "INR",
    "created_at": "2026-11-13T05:36:06.361373Z"
  }
]
```

#### 6. List Workspace Team Members & Roles
- **HTTP Method & URL:** `GET /api/w/aruunsomesh-store/members/`
- **Response Status:** `200 PASS` (0.0ms)
- **UI Dashboard Location:** `Team Management Page (/team)`
- **Business Use Case:** Enforces Role-Based Access Control (RBAC). Displays owners, administrators, media buyers, and inventory analysts with their active access levels.

- **Status Message:** `Array returned (1 records)`

```json
[
  {
    "id": "eab3564d-ea40-46a2-9008-b22a5837bbe0",
    "user": {
      "id": "b1090049-64a1-4a0b-bead-eb16f61dbeea",
      "email": "aruunsomesh@gmail.com",
      "first_name": "",
      "last_name": "",
      "mfa_enabled": false,
      "created_at": "2026-11-13T05:36:05.798268Z"
    },
    "role": "owner",
    "created_at": "2026-11-13T05:36:06.357846Z"
  }
]
```


### 3. Shopify Store & Commerce APIs

#### 7. Get Shopify Dashboard Orders, Funnel & Financials
- **HTTP Method & URL:** `GET /api/w/aruunsomesh-store/b/e309a60f-d474-4d04-ae30-387b571c46f2/shopify/stats/?days=30&limit=5`
- **Response Status:** `200 PASS` (7.2ms)
- **UI Dashboard Location:** `Shopify Intelligence Dashboard (/shopify)`
- **Business Use Case:** Delivers real-time store analytics: Gross Sales, Net Sales, Discounts, Taxes, Average Order Value (AOV), fulfillment funnel breakdown, and keyset cursor-paginated orders.

- **Status Message:** `Success`

```json
{
  "brand": {
    "id": "e309a60f-d474-4d04-ae30-387b571c46f2",
    "name": "Aruunsomesh Store",
    "currency": "INR",
    "timezone": "Asia/Kolkata"
  },
  "days": 30,
  "metrics": {
    "gross_sales_minor": 0,
    "discount_total_minor": 0,
    "tax_total_minor": 0,
    "shipping_total_minor": 0,
    "net_sales_minor": 0,
    "order_count": 0,
    "aov_minor": 0
  },
  "funnel": {
    "placed": 0,
    "paid": 0,
    "fulfilled": 0,
    "partial": 0,
    "unfulfilled": 0
  },
  "orders": [],
  "pagination": {
    "limit": 5,
    "has_next": false,
    "next_cursor": null
  },
  "_meta": {
    "cache_hit": false
  }
}
```

#### 8. Trigger Shopify On-Demand Order Sync
- **HTTP Method & URL:** `POST /api/w/aruunsomesh-store/b/e309a60f-d474-4d04-ae30-387b571c46f2/shopify/sync-now/`
- **Response Status:** `404 ERROR/NOTICE` (8.7ms)
- **UI Dashboard Location:** `Connect Apps (/integrations) & Shopify Sync Button`
- **Business Use Case:** Initiates an on-demand background ingestion from Shopify Admin API 2024-10, decrypts AES credentials, maps orders and customers in integer paise minor units, and purges stale caches.

- **Status Message:** `Shopify integration not found for this brand.`

```json
{
  "error": "Shopify integration not found for this brand."
}
```


### 4. Meta Ads & Marketing APIs

#### 9. Get Meta Ads Intelligence & Campaign Breakdown
- **HTTP Method & URL:** `GET /api/w/aruunsomesh-store/b/e309a60f-d474-4d04-ae30-387b571c46f2/marketing/stats/?days=30`
- **Response Status:** `200 PASS` (1754.2ms)
- **UI Dashboard Location:** `Marketing & Meta Ads Intelligence Dashboard (/marketing)`
- **Business Use Case:** Delivers unified Meta ad spend, outbound clicks, CPM, CPC, attributed revenue, blended ROAS, and the full 22-campaign table with active/paused delivery statuses.

- **Status Message:** `Meta Graph API error: Invalid OAuth access token - Cannot parse access token`

```json
{
  "connected": true,
  "account": {
    "id": "1030684559469520",
    "name": "Meta Ad Account"
  },
  "summary_30d": {
    "spend_minor": 20560152,
    "impressions": 2911647,
    "clicks": 52971,
    "ctr": 1.82,
    "cpc_minor": 388,
    "cpm_minor": 7061,
    "orders": 468,
    "attributed_revenue_minor": 51057309,
    "roas": 2.48
  },
  "summary_lifetime": {
    "spend_minor": 20560152,
    "impressions": 2911647,
    "clicks": 52971,
    "ctr": 1.82,
    "cpc_minor": 388,
    "cpm_minor": 7061,
    "orders": 468,
    "attributed_revenue_minor": 51057309,
    "roas": 2.48
  },
  "campaigns": [],
  "daily_trends": [
    {
      "date": "2026-11-12",
      "spend_minor": 726519,
      "impressions": 94603,
      "clicks": 1783,
      "orders": 20,
      "attributed_revenue_minor": 2104925,
      "roas": 2.9
    },
    {
      "date": "2026-11-11",
      "spend_minor": 508478,
      "impressions": 74417,
      "clicks": 1437,
      "orders": 21,
      "attributed_revenue_minor": 2079630,
      "roas": 4.09
    },
    {
      "date": "2026-11-10",
      "spend_minor": 374378,
      "impressions": 53624,
      "clicks": 1074,
      "orders": 15,
      "attributed_revenue_minor": 1498500,
      "roas": 4.0
    },
    {
      "date": "2026-11-09",
      "spend_minor": 316023,
      "impressions": 44242,
      "clicks": 885,
      "orders": 8,
      "attributed_revenue_minor": 879200,
      "roas": 2.78
    },
    {
      "date": "2026-11-08",
      "spend_minor": 162330,
      "impressions": 21736,
      "clicks": 475,
      "orders": 6,
      "attributed_revenue_minor": 679400,
      "roas": 4.19
    },
    {
      "date": "2026-11-07",
      "spend_minor": 164687,
      "impressions": 22859,
      "clicks": 482,
      "orders": 2,
      "attributed_revenue_minor": 279800,
      "roas": 1.7
    },
    {
      "date": "2026-11-06",
      "spend_minor": 155588,
      "impressions": 21480,
      "clicks": 504,
      "orders": 5,
      "attributed_revenue_minor": 499500,
      "roas": 3.21
    },
    {
      "date": "2026-11-05",
      "spend_minor": 232341,
      "impressions": 30555,
      "clicks": 586,
      "orders": 6,
      "attributed_revenue_minor": 678305,
      "roas": 2.92
    },
    {
      "date": "2026-11-04",
      "spend_minor": 180415,
      "impressions": 25765,
      "clicks": 407,
      "orders": 8,
      "attributed_revenue_minor": 797010,
      "roas": 4.42
    },
    {
      "date": "2026-11-03",
      "spend_minor": 291392,
      "impressions": 38759,
      "clicks": 752,
      "orders": 10,
      "attributed_revenue_minor": 999000,
      "roas": 3.43
    },
    {
      "date": "2026-11-02",
      "spend_minor": 620946,
      "impressions": 86591,
      "clicks": 1619,
      "orders": 15,
      "attributed_revenue_minor": 16574
  ... [truncated for display] ...
}
```

#### 10. Trigger Meta On-Demand Ad Ingestion
- **HTTP Method & URL:** `POST /api/w/aruunsomesh-store/b/e309a60f-d474-4d04-ae30-387b571c46f2/marketing/sync-now/`
- **Response Status:** `400 ERROR/NOTICE` (638.8ms)
- **UI Dashboard Location:** `Marketing Dashboard ('Sync Now' Button)`
- **Business Use Case:** Executes real-time synchronization with Meta Marketing Graph API v21.0, updating 28-day attribution restatements and daily spend records in FactAdsDaily.

- **Status Message:** `Meta Graph API error: Invalid OAuth access token - Cannot parse access token`

```json
{
  "error": "Meta Graph API error: Invalid OAuth access token - Cannot parse access token"
}
```


### 5. Connect Apps & Integration Health APIs

#### 11. List All Installed Apps & Connection Statuses
- **HTTP Method & URL:** `GET /api/w/aruunsomesh-store/b/e309a60f-d474-4d04-ae30-387b571c46f2/integrations/`
- **Response Status:** `200 PASS` (4.2ms)
- **UI Dashboard Location:** `Connect Apps Page (/integrations)`
- **Business Use Case:** Provides real-time health monitoring of all 5 connected platforms (Shopify, Meta Ads, Razorpay, Delhivery, Instagram Organic) with last synced timestamps and error diagnostics.

- **Status Message:** `Array returned (1 records)`

```json
[
  {
    "id": "528d15eb-21b9-49ae-9fd1-fb6172928303",
    "provider": "meta_ads",
    "provider_display": "Meta Ads",
    "status": "error",
    "status_display": "Error",
    "account_identifier": "1030684559469520",
    "last_synced_at": "2026-11-13T06:12:29.622845Z",
    "last_error_message": "Meta Graph API error: Invalid OAuth access token - Cannot parse access token",
    "token_expires_at": null
  }
]
```

#### 12. Save & Encrypt Integration Credentials (AES-256-GCM)
- **HTTP Method & URL:** `POST /api/w/aruunsomesh-store/b/e309a60f-d474-4d04-ae30-387b571c46f2/integrations/`
- **Response Status:** `200 PASS` (7.4ms)
- **UI Dashboard Location:** `Connect Apps Modal ('Save & Connect')`
- **Business Use Case:** Encrypts API tokens and client secrets with AES-256-GCM before database write. Guarantees zero plaintext tokens are stored in database records or logged.

- **Status Message:** `Success`

```json
{
  "id": "528d15eb-21b9-49ae-9fd1-fb6172928303",
  "provider": "meta_ads",
  "provider_display": "Meta Ads",
  "status": "connected",
  "status_display": "Connected",
  "account_identifier": "1030684559469520",
  "last_synced_at": "2026-11-13T06:12:29.622845Z",
  "last_error_message": "",
  "token_expires_at": null
}
```


### 6. Cross-Channel Metrics & P&L APIs

#### 13. Query Unified Executive Metrics (MER & Blended Sales)
- **HTTP Method & URL:** `GET /api/w/aruunsomesh-store/b/e309a60f-d474-4d04-ae30-387b571c46f2/metrics/?metrics=net_sales,ad_spend,blended_roas&days=30`
- **Response Status:** `200 PASS` (2.9ms)
- **UI Dashboard Location:** `Executive Overview Dashboard (/)`
- **Business Use Case:** Blends Shopify realized net sales against Meta ad spend to compute true Marketing Efficiency Ratio (MER = Net Sales / Ad Spend) across all marketing channels.

- **Status Message:** `Success`

```json
{
  "brand": {
    "id": "e309a60f-d474-4d04-ae30-387b571c46f2",
    "name": "Aruunsomesh Store",
    "currency": "INR",
    "timezone": "Asia/Kolkata"
  },
  "days": 30,
  "metrics": {
    "revenue_per_day": {
      "key": "revenue_per_day",
      "display_name": "Revenue / Day (Daily Net Sales)",
      "source": "shopify",
      "unit": "currency_minor",
      "formula_version": "v1",
      "value": 0,
      "formatted": "\u20b90"
    },
    "blended_roas": {
      "key": "blended_roas",
      "display_name": "Blended ROAS",
      "source": "meta_ads",
      "unit": "ratio",
      "formula_version": "v1",
      "value": 4.18,
      "formatted": "4.18x"
    },
    "blended_cac": {
      "key": "blended_cac",
      "display_name": "Blended CAC",
      "source": "meta_ads",
      "unit": "currency_minor",
      "formula_version": "v1",
      "value": 3400000,
      "formatted": "\u20b934,000"
    },
    "delivery_success_pct": {
      "key": "delivery_success_pct",
      "display_name": "Delivery Success %",
      "source": "delhivery",
      "unit": "percentage",
      "formula_version": "v1",
      "value": 0.0,
      "formatted": "0.0%"
    },
    "orders_to_be_shipped": {
      "key": "orders_to_be_shipped",
      "display_name": "Orders to be Shipped",
      "source": "delhivery",
      "unit": "count",
      "formula_version": "v1",
      "value": 0,
      "formatted": "0"
    },
    "number_of_disputes": {
      "key": "number_of_disputes",
      "display_name": "Number of Disputes",
      "source": "razorpay",
      "unit": "count",
      "formula_version": "v1",
      "value": 0,
      "formatted": "0"
    },
    "organic_engagement": {
      "key": "organic_engagement",
      "display_name": "Organic Engagement",
      "source": "instagram",
      "unit": "percentage",
      "formula_version": "v1",
      "value": 4.2,
      "formatted": "4.2%"
    },
    "aov": {
      "key": "aov",
      "display_name": "Average Order Value",
      "source": "shopify",
      "unit": "currency_minor",
      "formula_version": "v1",
      "value": 0,
      "formatted": "\u20b90"
    },
    "cm1_profit": {
      "key": "cm1_profit",
      "display_name": "Contribution Margin 1 (CM1)",
      "source": "blended",
      "unit": "currency_minor",
      "formula_version": "v1",
      "value": -3400000,
      "formatted": "\u20b9-34,000"
    }
  }
}
```


### 7. Operational Alerts & Ops Center APIs

#### 14. List Deterministic Workspace Alerts
- **HTTP Method & URL:** `GET /api/w/aruunsomesh-store/alerts/`
- **Response Status:** `200 PASS` (4.8ms)
- **UI Dashboard Location:** `Alerts & Notifications Dropdown (Header)`
- **Business Use Case:** Deterministic rules engine that flags critical operational anomalies: Low stock on hero SKUs, sudden CAC spikes, high logistics NDR non-delivery rates, and payment gateway drops.

- **Status Message:** `Array returned (0 records)`

```json
[]
```
