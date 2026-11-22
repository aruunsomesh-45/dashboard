-- ============================================================================
-- Migration: 20261121000015_fix_commerce_stats_auth_guard.sql
-- Description: Make the authorization guard in get_brand_commerce_stats NULL-safe.
--
-- Bug: the guard was
--     IF NOT (p_workspace_id = public.current_tenant_workspace_id()
--             OR public.is_member_of_workspace(p_workspace_id)) THEN RAISE ...
-- For a normal Supabase user current_tenant_workspace_id() is NULL, so for a NON-member the
-- condition is NOT (NULL OR FALSE) = NULL, and PL/pgSQL treats a NULL condition as false:
-- the RAISE never fired. RLS (SECURITY INVOKER) still hid the rows, so no data leaked, but the
-- explicit check was a no-op and outsiders received an all-zero "empty dashboard" instead of an error.
--
-- Found by serverless/tests/db/e2e_workflows.test.ts ("workspace isolation" step).
-- Body is otherwise identical to 20261112000011.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_brand_commerce_stats(
    p_workspace_id UUID,
    p_brand_id UUID,
    p_days INT
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_since TIMESTAMPTZ;
    v_result JSONB;
BEGIN
    IF NOT (
        COALESCE(p_workspace_id = public.current_tenant_workspace_id(), FALSE)
        OR COALESCE(public.is_member_of_workspace(p_workspace_id), FALSE)
    ) THEN
        RAISE EXCEPTION 'Unauthorized workspace access' USING ERRCODE = '42501';
    END IF;

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

REVOKE ALL ON FUNCTION public.get_brand_commerce_stats(UUID, UUID, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_brand_commerce_stats(UUID, UUID, INT) TO authenticated, app_user, service_role;
