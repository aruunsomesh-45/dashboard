-- ============================================================================
-- Migration: 20261110000007_indexes_and_optimizations.sql
-- Description: B-Tree, GIN Trigram, Composite & Partial Performance Indexes
-- ============================================================================

-- 1. Tenancy Core Lookups
CREATE INDEX IF NOT EXISTS idx_workspace_slug ON public.tenancy_workspace(slug);
CREATE INDEX IF NOT EXISTS idx_brand_workspace ON public.tenancy_brand(workspace_id);
CREATE INDEX IF NOT EXISTS idx_workspacemember_user ON public.tenancy_workspacemember(user_id);
CREATE INDEX IF NOT EXISTS idx_auditlog_workspace_created ON public.tenancy_auditlog(workspace_id, created_at DESC);

-- 2. Transactional Orders & Customers
CREATE INDEX IF NOT EXISTS idx_order_brand_created ON public.commerce_order(brand_id, source_created_at DESC);
CREATE INDEX IF NOT EXISTS idx_order_customer ON public.commerce_order(customer_id);
CREATE INDEX IF NOT EXISTS idx_order_financial_fulfillment ON public.commerce_order(financial_status, fulfillment_status);
CREATE INDEX IF NOT EXISTS idx_orderline_order ON public.commerce_orderline(order_id);
CREATE INDEX IF NOT EXISTS idx_customer_brand_email ON public.commerce_customer(brand_id, email);
CREATE INDEX IF NOT EXISTS idx_customer_brand_phone ON public.commerce_customer(brand_id, phone);

-- 3. Payments & Logistics
CREATE INDEX IF NOT EXISTS idx_payment_brand_created ON public.commerce_paymentattempt(brand_id, source_created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_status ON public.commerce_paymentattempt(status);
CREATE INDEX IF NOT EXISTS idx_payment_gateway_order ON public.commerce_paymentattempt(gateway_order_id);
CREATE INDEX IF NOT EXISTS idx_shipment_brand_status ON public.commerce_shipment(brand_id, canonical_status);
CREATE INDEX IF NOT EXISTS idx_shipment_awb ON public.commerce_shipment(awb);
CREATE INDEX IF NOT EXISTS idx_tracking_shipment ON public.commerce_trackingevent(shipment_id, occurred_at DESC);

-- 4. GIN Trigram Fuzzy Search Indexes (Cross-Channel Universal Search)
CREATE INDEX IF NOT EXISTS idx_trgm_order_number ON public.commerce_order USING gin (order_number gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_trgm_customer_phone ON public.commerce_customer USING gin (phone gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_trgm_customer_email ON public.commerce_customer USING gin (email gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_trgm_shipment_awb ON public.commerce_shipment USING gin (awb gin_trgm_ops);

-- 5. Daily Fact Rollups (Dashboard Metric Serving)
CREATE INDEX IF NOT EXISTS idx_factshop_brand_date ON public.analytics_factshopdaily(brand_id, fact_date DESC);
CREATE INDEX IF NOT EXISTS idx_factads_brand_date ON public.analytics_factadsdaily(brand_id, fact_date DESC);

-- 6. Operational Alerts & Deduplication
CREATE INDEX IF NOT EXISTS idx_alerts_workspace_status ON public.alerts_alert(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_alerts_brand_severity ON public.alerts_alert(brand_id, severity);

-- 7. Webhooks & Ingestion Processing Partial Indexes
CREATE INDEX IF NOT EXISTS idx_webhook_unprocessed ON public.integrations_webhookevent(processed, created_at) 
    WHERE processed = FALSE;
CREATE INDEX IF NOT EXISTS idx_rawpayload_brand_provider ON public.integrations_rawpayload(brand_id, provider, created_at DESC);
