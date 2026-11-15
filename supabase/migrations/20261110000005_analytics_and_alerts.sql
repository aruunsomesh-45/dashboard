-- ============================================================================
-- Migration: 20261110000005_analytics_and_alerts.sql
-- Description: Fact Tables, Deterministic Alerts, Subscriptions & Aggregation Functions
-- ============================================================================

-- 1. Daily Fact Rollup for Shopify Orders
CREATE TABLE IF NOT EXISTS public.analytics_factshopdaily (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES public.tenancy_workspace(id) ON DELETE CASCADE,
    brand_id UUID NOT NULL REFERENCES public.tenancy_brand(id) ON DELETE CASCADE,
    fact_date DATE NOT NULL,
    gross_sales BIGINT NOT NULL DEFAULT 0,
    discount_amount BIGINT NOT NULL DEFAULT 0,
    tax_amount BIGINT NOT NULL DEFAULT 0,
    shipping_amount BIGINT NOT NULL DEFAULT 0,
    net_sales BIGINT NOT NULL DEFAULT 0,
    orders_count INTEGER NOT NULL DEFAULT 0 CHECK (orders_count >= 0),
    customers_count INTEGER NOT NULL DEFAULT 0 CHECK (customers_count >= 0),
    items_count INTEGER NOT NULL DEFAULT 0 CHECK (items_count >= 0),
    fulfilled_orders_count INTEGER NOT NULL DEFAULT 0 CHECK (fulfilled_orders_count >= 0),
    unfulfilled_orders_count INTEGER NOT NULL DEFAULT 0 CHECK (unfulfilled_orders_count >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_analytics_factshopdaily UNIQUE (brand_id, fact_date)
);

CREATE TRIGGER trg_analytics_factshopdaily_updated_at
BEFORE UPDATE ON public.analytics_factshopdaily
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 2. Daily Fact Rollup for Meta Ads (28-day restated)
CREATE TABLE IF NOT EXISTS public.analytics_factadsdaily (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES public.tenancy_workspace(id) ON DELETE CASCADE,
    brand_id UUID NOT NULL REFERENCES public.tenancy_brand(id) ON DELETE CASCADE,
    fact_date DATE NOT NULL,
    spend_minor BIGINT NOT NULL DEFAULT 0 CHECK (spend_minor >= 0),
    impressions BIGINT NOT NULL DEFAULT 0 CHECK (impressions >= 0),
    clicks BIGINT NOT NULL DEFAULT 0 CHECK (clicks >= 0),
    attributed_conversions INTEGER NOT NULL DEFAULT 0 CHECK (attributed_conversions >= 0),
    attributed_revenue_minor BIGINT NOT NULL DEFAULT 0 CHECK (attributed_revenue_minor >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_analytics_factadsdaily UNIQUE (brand_id, fact_date)
);

CREATE TRIGGER trg_analytics_factadsdaily_updated_at
BEFORE UPDATE ON public.analytics_factadsdaily
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 3. Deterministic Alerts Center
CREATE TABLE IF NOT EXISTS public.alerts_alert (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES public.tenancy_workspace(id) ON DELETE CASCADE,
    brand_id UUID NOT NULL REFERENCES public.tenancy_brand(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    severity VARCHAR(20) NOT NULL DEFAULT 'warning',
    status VARCHAR(20) NOT NULL DEFAULT 'open',
    dedupe_key VARCHAR(255) NOT NULL,
    acknowledged_by_id UUID NULL REFERENCES public.accounts_user(id) ON DELETE SET NULL,
    acknowledged_at TIMESTAMPTZ NULL,
    resolved_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_alerts_workspace_dedupe UNIQUE (workspace_id, dedupe_key),
    CONSTRAINT chk_alerts_severity CHECK (severity IN ('critical', 'warning', 'info')),
    CONSTRAINT chk_alerts_status CHECK (status IN ('open', 'acknowledged', 'resolved'))
);

CREATE TRIGGER trg_alerts_alert_updated_at
BEFORE UPDATE ON public.alerts_alert
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 4. Billing & SaaS Subscription Limits
CREATE TABLE IF NOT EXISTS public.billing_subscription (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES public.tenancy_workspace(id) ON DELETE CASCADE,
    plan VARCHAR(30) NOT NULL DEFAULT 'starter',
    status VARCHAR(30) NOT NULL DEFAULT 'active',
    max_brands INTEGER NOT NULL DEFAULT 1 CHECK (max_brands > 0),
    max_members INTEGER NOT NULL DEFAULT 3 CHECK (max_members > 0),
    history_days_limit INTEGER NOT NULL DEFAULT 30 CHECK (history_days_limit > 0),
    current_period_start TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    current_period_end TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_billing_subscription_workspace UNIQUE (workspace_id),
    CONSTRAINT chk_billing_plan CHECK (plan IN ('starter', 'growth', 'enterprise')),
    CONSTRAINT chk_billing_status CHECK (status IN ('active', 'past_due', 'canceled', 'trialing'))
);

CREATE TRIGGER trg_billing_subscription_updated_at
BEFORE UPDATE ON public.billing_subscription
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 5. Stored Procedure: Incremental Fact Recalculation
CREATE OR REPLACE FUNCTION public.refresh_daily_fact_shop(
    p_brand_id UUID, 
    p_target_date DATE
)
RETURNS VOID AS $$
DECLARE
    v_workspace_id UUID;
    v_tz VARCHAR(50);
BEGIN
    SELECT workspace_id, timezone INTO v_workspace_id, v_tz 
    FROM public.tenancy_brand WHERE id = p_brand_id;

    INSERT INTO public.analytics_factshopdaily (
        workspace_id,
        brand_id,
        fact_date,
        gross_sales,
        discount_amount,
        tax_amount,
        shipping_amount,
        net_sales,
        orders_count,
        customers_count,
        items_count,
        fulfilled_orders_count,
        unfulfilled_orders_count,
        updated_at
    )
    SELECT
        v_workspace_id,
        p_brand_id,
        p_target_date,
        COALESCE(SUM(o.gross_amount), 0),
        COALESCE(SUM(o.discount_amount), 0),
        COALESCE(SUM(o.tax_amount), 0),
        COALESCE(SUM(o.shipping_amount), 0),
        COALESCE(SUM(o.net_sales), 0),
        COUNT(o.id),
        COUNT(DISTINCT o.customer_id),
        COALESCE(SUM(ol.items_total), 0),
        COUNT(CASE WHEN o.fulfillment_status = 'fulfilled' THEN 1 END),
        COUNT(CASE WHEN o.fulfillment_status = 'unfulfilled' THEN 1 END),
        clock_timestamp()
    FROM public.commerce_order o
    LEFT JOIN (
        SELECT order_id, SUM(quantity) AS items_total 
        FROM public.commerce_orderline 
        GROUP BY order_id
    ) ol ON ol.order_id = o.id
    WHERE o.brand_id = p_brand_id
      AND (o.source_created_at AT TIME ZONE 'UTC' AT TIME ZONE v_tz)::DATE = p_target_date
      AND o.financial_status != 'voided'
    ON CONFLICT (brand_id, fact_date) DO UPDATE SET
        gross_sales = EXCLUDED.gross_sales,
        discount_amount = EXCLUDED.discount_amount,
        tax_amount = EXCLUDED.tax_amount,
        shipping_amount = EXCLUDED.shipping_amount,
        net_sales = EXCLUDED.net_sales,
        orders_count = EXCLUDED.orders_count,
        customers_count = EXCLUDED.customers_count,
        items_count = EXCLUDED.items_count,
        fulfilled_orders_count = EXCLUDED.fulfilled_orders_count,
        unfulfilled_orders_count = EXCLUDED.unfulfilled_orders_count,
        updated_at = clock_timestamp();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
