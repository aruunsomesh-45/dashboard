/**
 * 125 EAST APIs Client Library
 * Unified export of all external & internal system API clients.
 */

// Core Client
export * from "./client";

// 1. Shopify
export * from "./Shopify/orders.api";
export * from "./Shopify/products.api";
export * from "./Shopify/customers.api";
export * from "./Shopify/webhooks.api";

// 2. Meta
export * from "./Meta/campaigns.api";
export * from "./Meta/insights.api";
export * from "./Meta/ads.api";

// 3. Razorpay
export * from "./Razorpay/payments.api";
export * from "./Razorpay/refunds.api";
export * from "./Razorpay/webhooks.api";

// 4. Logistics
export * from "./Logistics/shipments.api";
export * from "./Logistics/tracking.api";

// 5. Supabase
export * from "./Supabase/auth.api";
export * from "./Supabase/database.api";

// 6. Dashboard
export * from "./Dashboard/overview.api";
export * from "./Dashboard/revenue.api";
export * from "./Dashboard/roas.api";
export * from "./Dashboard/pnl.api";

// 7. Sync
export * from "./Sync/sync.api";
export * from "./Sync/status.api";
