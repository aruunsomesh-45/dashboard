-- ==============================================================================
-- Migration: 20261110000010_performance_optimizations.sql
-- Purpose: Database optimizations for 500 registered users & concurrent workloads
--          1. Covering indexes for Index-Only Scans
--          2. Keyset / cursor pagination indexes
--          3. Webhook idempotency and queue processing indexes
--          4. Fast in-kernel single-pass aggregation function
-- ==============================================================================

-- 1. Covering Index for Orders Aggregations (Enables Index-Only Scan without table heap reads)
CREATE INDEX IF NOT EXISTS idx_order_covering_agg
ON public.commerce_order (brand_id, provider, source_created_at DESC)
INCLUDE (gross_amount, discount_amount, tax_amount, shipping_amount, net_sales, financial_status, fulfillment_status);

-- 2. Keyset / Cursor Pagination Index for O(1) Orders Feed
CREATE INDEX IF NOT EXISTS idx_order_keyset_pag
ON public.commerce_order (brand_id, source_created_at DESC, id DESC);

-- 3. Daily Fact Rollup Covering Index for Multi-Day Range Queries
CREATE INDEX IF NOT EXISTS idx_factshop_covering_range
ON public.analytics_factshopdaily (brand_id, fact_date DESC)
INCLUDE (gross_sales, discount_amount, tax_amount, net_sales, orders_count, fulfilled_orders_count, unfulfilled_orders_count);

-- 4. Order Lines FK & Sums Covering Index (Eliminates N+1 Heap Reads)
CREATE INDEX IF NOT EXISTS idx_orderline_order_covering
ON public.commerce_orderline (order_id)
INCLUDE (quantity, price_minor, total_discount_minor);

-- 5. Webhook Idempotency Unique Index (Partition-safe)
CREATE UNIQUE INDEX IF NOT EXISTS uq_webhook_idempotency
ON public.integrations_webhookevent (brand_id, provider, event_id, created_at);

-- 6. Unprocessed Webhook Queue Index for Background Job Processing
CREATE INDEX IF NOT EXISTS idx_webhook_unprocessed_queue
ON public.integrations_webhookevent (created_at ASC)
WHERE (processed = false);

-- 7. Optimized Single-Pass In-Kernel Aggregation Function
CREATE OR REPLACE FUNCTION public.get_brand_commerce_stats(
    p_workspace_id UUID,
    p_brand_id UUID,
    p_days INT
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_since TIMESTAMPTZ;
    v_result JSONB;
BEGIN
    v_since := NOW() - (p_days || ' days')::INTERVAL;

    SELECT jsonb_build_object(
        'gross_sales_minor', COALESCE(SUM(gross_amount), 0),
        'discount_total_minor', COALESCE(SUM(discount_amount), 0),
        'tax_total_minor', COALESCE(SUM(tax_amount), 0),
        'shipping_total_minor', COALESCE(SUM(shipping_amount), 0),
        'net_sales_minor', COALESCE(SUM(net_sales), 0),
        'order_count', COUNT(id),
        'aov_minor', CASE WHEN COUNT(id) > 0 THEN ROUND(COALESCE(SUM(net_sales), 0) / COUNT(id)) ELSE 0 END,
        'placed', COUNT(id),
        'paid', COUNT(id) FILTER (WHERE financial_status = 'paid'),
        'fulfilled', COUNT(id) FILTER (WHERE fulfillment_status = 'fulfilled'),
        'partial', COUNT(id) FILTER (WHERE fulfillment_status = 'partial'),
        'unfulfilled', COUNT(id) FILTER (WHERE fulfillment_status = 'unfulfilled')
    )
    INTO v_result
    FROM public.commerce_order
    WHERE workspace_id = p_workspace_id
      AND brand_id = p_brand_id
      AND provider = 'shopify'
      AND (source_created_at >= v_since OR source_created_at IS NULL);

    RETURN v_result;
END;
$$;
