# 125 EAST — Unified Commerce Intelligence API Architecture

This document describes the structured API client architecture in `125east/APIs/`, explaining **what each API does, why our system needs it, and how data flows from external partners into your dashboards**.

---

## 1. Directory Structure

```
125east/
│
├── APIs/
│   ├── client.ts                 # Shared typed HTTP transport & error normalization
│   ├── index.ts                  # Central entry point exporting all modules
│   │
│   ├── Shopify/                  # Store, Catalog & Ingestion
│   │   ├── orders.api.ts         # Orders, line items, and fulfillment pipeline
│   │   ├── products.api.ts       # Product catalog, SKUs, inventory levels
│   │   ├── customers.api.ts      # Customer LTV and cohort profiles
│   │   └── webhooks.api.ts       # Inbound HMAC-verified real-time order streaming
│   │
│   ├── Meta/                     # Paid Advertising & Growth
│   │   ├── campaigns.api.ts      # Campaign lifecycle and budget status
│   │   ├── insights.api.ts       # Daily spend, impressions, clicks, 28D restatements
│   │   └── ads.api.ts            # Ad creatives, fatigue detection, and asset ROAS
│   │
│   ├── Razorpay/                 # Payment Gateway Reconciliation
│   │   ├── payments.api.ts       # Captured charges, UPI/card breakdown, auth rates
│   │   ├── refunds.api.ts        # Instant refunds, chargebacks, dispute logs
│   │   └── webhooks.api.ts       # Payment event signature verification
│   │
│   ├── Logistics/                # Fulfillment & Carrier Telemetry
│   │   ├── shipments.api.ts      # Dispatched orders, carrier SLAs, shipping spend
│   │   └── tracking.api.ts       # Live AWB scans, NDR re-attempts, RTO recovery
│   │
│   ├── Supabase/                 # Authentication & Tenancy
│   │   ├── auth.api.ts           # User profiles, JWT validation, CSRF tokens
│   │   └── database.api.ts       # Multi-tenant workspace entities, RLS isolation
│   │
│   ├── Dashboard/                # Cross-Channel Analytics & Financials
│   │   ├── overview.api.ts       # Executive blended KPI command center
│   │   ├── revenue.api.ts        # Net revenue growth curves and discount velocity
│   │   ├── roas.api.ts           # Blended MER, CAC, cross-platform return
│   │   └── pnl.api.ts            # True P&L: COGS, logistics, ad spend & EBITDA
│   │
│   ├── Sync/                     # Ingestion Engine & Health
│   │   ├── sync.api.ts           # On-demand sync triggers for external APIs
│   │   └── status.api.ts         # Health checks, AES credential storage, audit logs
│   │
│   └── API_DOCUMENTATION.md      # Architecture guide and usage documentation
```

---

## 2. API Catalog & Why We Use Each One

### 🛍️ Shopify APIs (`APIs/Shopify/`)

| File | Primary Functions | Why We Use It |
| :--- | :--- | :--- |
| **`orders.api.ts`** | `getOrders()`, `getOrderById()` | Pulls placed, paid, and fulfilled orders. Calculates Gross Sales, Discounts, Taxes, and Net Sales in integer **minor units (paise)** to eliminate float rounding errors. Powers `/shopify` and `/`. |
| **`products.api.ts`** | `getProducts()`, `getLowStockAlerts()` | Synchronizes product variants, active SKUs, and inventory thresholds to trigger automated out-of-stock and re-order alerts. |
| **`customers.api.ts`** | `getCustomers()`, `getCustomerById()` | Tracks Customer Lifetime Value (LTV), total purchase frequency, and repeat buyer cohorts. |
| **`webhooks.api.ts`** | `registerWebhooks()`, `getActiveWebhooks()` | Configures real-time Shopify webhooks (`orders/create`, `refunds/create`) verified with HMAC SHA-256 for instant event delivery. |

---

### 📣 Meta Ads APIs (`APIs/Meta/`)

| File | Primary Functions | Why We Use It |
| :--- | :--- | :--- |
| **`campaigns.api.ts`** | `getCampaigns()`, `updateCampaignStatus()` | Fetches active and paused campaigns, budgets, and delivery status directly from Graph API v21.0. Allows toggling campaign spend from the dashboard. |
| **`insights.api.ts`** | `getInsights()`, `triggerSync()` | Pulls spend, impressions, clicks, CPC, CPM, and attributed purchase revenue. Ingests daily facts into `FactAdsDaily` and supports 28-day attribution restatements. Powers `/marketing`. |
| **`ads.api.ts`** | `getAdCreatives()` | Breaks down metrics to the creative level (Reels, Carousels, Static images) so you know which ad copy drives revenue and which has fatigued. |

---

### 💳 Razorpay APIs (`APIs/Razorpay/`)

| File | Primary Functions | Why We Use It |
| :--- | :--- | :--- |
| **`payments.api.ts`** | `getPayments()`, `getPaymentStats()` | Tracks authorization success rates, gateway transaction fees (2% + GST), and payment method splits (UPI vs Credit Card vs NetBanking). Powers `/payments`. |
| **`refunds.api.ts`** | `getRefunds()`, `createRefund()` | Reconciles bank settlements against customer refunds and chargebacks to prevent accounting discrepancies. |
| **`webhooks.api.ts`** | `getWebhookConfig()` | Verifies inbound payment callbacks (`payment.captured`, `payment.failed`) using HMAC SHA-256 secrets. |

---

### 🚚 Logistics APIs (`APIs/Logistics/`)

| File | Primary Functions | Why We Use It |
| :--- | :--- | :--- |
| **`shipments.api.ts`** | `getShipments()`, `getSummary()` | Aggregates dispatched orders across Delhivery, Shiprocket, or BlueDart. Tracks transit times, carrier SLAs, and shipping cost line items. Powers `/logistics`. |
| **`tracking.api.ts`** | `trackAwb()`, `triggerNdrReattempt()` | Live AWB milestone tracking. Automates Non-Delivery Report (NDR) actions (re-attempt vs RTO) to save shipping loss on Cash on Delivery (COD) orders. |

---

### 🛡️ Supabase APIs (`APIs/Supabase/`)

| File | Primary Functions | Why We Use It |
| :--- | :--- | :--- |
| **`auth.api.ts`** | `getCurrentUser()`, `refreshCsrfToken()`, `logout()` | Bridges Supabase Bearer JWTs to Django DRF sessions, verifies user identity, and handles CSRF protection. |
| **`database.api.ts`** | `getWorkspaces()`, `getWorkspaceBySlug()` | Enforces multi-tenant workspace boundaries, brand switcher routing, and Row Level Security (RLS) policies. |

---

### 📊 Dashboard & Financial APIs (`APIs/Dashboard/`)

| File | Primary Functions | Why We Use It |
| :--- | :--- | :--- |
| **`overview.api.ts`** | `getOverview()` | Executive command center scorecard: blends net sales, ad spend, blended ROAS, cash balance, and NDR rates into one view. Powers `/`. |
| **`revenue.api.ts`** | `getDailyRevenue()` | Renders 30-day and 90-day revenue trends, discounting velocity, and seasonal spikes. |
| **`roas.api.ts`** | `getRoasMetrics()` | Computes true Marketing Efficiency Ratio (MER = Total Revenue / Total Ad Spend) and per-channel Customer Acquisition Cost (CAC). |
| **`pnl.api.ts`** | `getPnlStatement()` | Automatically generates a GAAP-standard P&L: Gross Revenue &minus; Discounts &minus; Returns &minus; COGS &minus; Ad Spend &minus; Logistics &minus; Gateway Fees = **True Net EBITDA**. Powers `/pnl`. |

---

### 🔄 Sync & Infrastructure APIs (`APIs/Sync/`)

| File | Primary Functions | Why We Use It |
| :--- | :--- | :--- |
| **`sync.api.ts`** | `triggerSync()` | Powers the "Sync Now" button across the entire UI. Triggers on-demand background ingestion from Shopify, Meta, Razorpay, or Delhivery. |
| **`status.api.ts`** | `getIntegrationStatuses()`, `saveCredentials()`, `disconnectIntegration()`, `getSyncRuns()` | Powers the Connect Apps page (`/integrations`). Encrypts API tokens with AES-256-GCM before database write, checks token expiration, and provides audit logs. |

---

## 3. Usage Example

To fetch live Meta Ads and Shopify data anywhere in your frontend or scripts:

```typescript
import { shopifyOrdersApi, metaInsightsApi, syncApi } from "@/APIs";

// 1. Trigger an on-demand sync
await syncApi.triggerSync("aruunsomesh-store", "brand-uuid", "meta_ads");

// 2. Fetch fresh Meta Marketing stats
const metaStats = await metaInsightsApi.getInsights("aruunsomesh-store", "brand-uuid");
console.log(`Ad Spend: ₹${metaStats.summary_30d?.spend_minor / 100}, ROAS: ${metaStats.summary_30d?.roas}x`);

// 3. Fetch Shopify Orders
const ordersData = await shopifyOrdersApi.getOrders("aruunsomesh-store", "brand-uuid", { days: 30 });
console.log(`Net Sales: ₹${ordersData.metrics.net_sales_minor / 100}, Orders: ${ordersData.metrics.order_count}`);
```
