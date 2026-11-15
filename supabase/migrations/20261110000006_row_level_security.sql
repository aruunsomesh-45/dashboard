-- ============================================================================
-- Migration: 20261110000006_row_level_security.sql
-- Description: Multi-Tenant Row Level Security (RLS) Isolation & Access Policies
-- ============================================================================

-- Helper functions for resolving active tenant context
CREATE OR REPLACE FUNCTION public.current_tenant_workspace_id()
RETURNS UUID AS $$
BEGIN
    -- Reads transaction-scoped session variable set by TenancyMiddleware
    RETURN NULLIF(current_setting('app.workspace_id', TRUE), '')::UUID;
EXCEPTION
    WHEN OTHERS THEN
        RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

CREATE OR REPLACE FUNCTION public.is_member_of_workspace(ws_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
    -- Supports direct Supabase JWT auth.uid() check
    IF auth.uid() IS NULL THEN
        RETURN FALSE;
    END IF;

    RETURN EXISTS (
        SELECT 1 
        FROM public.tenancy_workspacemember 
        WHERE workspace_id = ws_id 
          AND user_id = auth.uid()
    );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

CREATE OR REPLACE FUNCTION public.has_brand_access(b_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
    v_ws_id UUID;
BEGIN
    SELECT workspace_id INTO v_ws_id FROM public.tenancy_brand WHERE id = b_id;
    IF v_ws_id IS NULL THEN
        RETURN FALSE;
    END IF;

    -- If backend session variable matches workspace
    IF v_ws_id = public.current_tenant_workspace_id() THEN
        RETURN TRUE;
    END IF;

    -- If Supabase JWT user
    IF auth.uid() IS NOT NULL THEN
        -- Check workspace membership
        IF EXISTS (SELECT 1 FROM public.tenancy_workspacemember WHERE workspace_id = v_ws_id AND user_id = auth.uid()) THEN
            -- Check if brand restriction exists
            IF NOT EXISTS (SELECT 1 FROM public.tenancy_brandmember WHERE brand_id = b_id) THEN
                RETURN TRUE; -- No restriction on brand
            ELSE
                RETURN EXISTS (SELECT 1 FROM public.tenancy_brandmember WHERE brand_id = b_id AND user_id = auth.uid());
            END IF;
        END IF;
    END IF;

    RETURN FALSE;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- Enable RLS across all tables
ALTER TABLE public.accounts_user ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounts_mfarecoverycode ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenancy_workspace ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenancy_brand ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenancy_workspacemember ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenancy_brandmember ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenancy_invite ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenancy_auditlog ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commerce_customer ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commerce_product ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commerce_productvariant ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commerce_order ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commerce_orderline ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commerce_paymentattempt ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commerce_shipment ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commerce_trackingevent ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commerce_orderpaymentlink ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commerce_ordershipmentlink ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integrations_integration ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integrations_rawpayload ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integrations_syncrun ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integrations_synccursor ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integrations_webhookevent ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analytics_factshopdaily ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analytics_factadsdaily ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alerts_alert ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_subscription ENABLE ROW LEVEL SECURITY;

-- Grant permissions to app_user and authenticated roles
GRANT USAGE ON SCHEMA public TO app_user, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user, authenticated;

-- 1. Accounts Policies
CREATE POLICY rls_user_self_access ON public.accounts_user
FOR ALL USING (
    id = auth.uid() OR id = NULLIF(current_setting('app.user_id', TRUE), '')::UUID
) WITH CHECK (
    id = auth.uid() OR id = NULLIF(current_setting('app.user_id', TRUE), '')::UUID
);

CREATE POLICY rls_mfarecovery_self_access ON public.accounts_mfarecoverycode
FOR ALL USING (
    user_id = auth.uid() OR user_id = NULLIF(current_setting('app.user_id', TRUE), '')::UUID
) WITH CHECK (
    user_id = auth.uid() OR user_id = NULLIF(current_setting('app.user_id', TRUE), '')::UUID
);

-- 2. Workspace & Memberships Policies
CREATE POLICY rls_workspace_isolation ON public.tenancy_workspace
FOR ALL USING (
    id = public.current_tenant_workspace_id() OR public.is_member_of_workspace(id)
) WITH CHECK (
    id = public.current_tenant_workspace_id() OR public.is_member_of_workspace(id)
);

CREATE POLICY rls_workspacemember_isolation ON public.tenancy_workspacemember
FOR ALL USING (
    workspace_id = public.current_tenant_workspace_id() OR public.is_member_of_workspace(workspace_id)
) WITH CHECK (
    workspace_id = public.current_tenant_workspace_id() OR public.is_member_of_workspace(workspace_id)
);

CREATE POLICY rls_brand_isolation ON public.tenancy_brand
FOR ALL USING (
    workspace_id = public.current_tenant_workspace_id() OR public.is_member_of_workspace(workspace_id)
) WITH CHECK (
    workspace_id = public.current_tenant_workspace_id() OR public.is_member_of_workspace(workspace_id)
);

CREATE POLICY rls_brandmember_isolation ON public.tenancy_brandmember
FOR ALL USING (
    public.has_brand_access(brand_id)
) WITH CHECK (
    public.has_brand_access(brand_id)
);

CREATE POLICY rls_invite_isolation ON public.tenancy_invite
FOR ALL USING (
    workspace_id = public.current_tenant_workspace_id() OR public.is_member_of_workspace(workspace_id)
) WITH CHECK (
    workspace_id = public.current_tenant_workspace_id() OR public.is_member_of_workspace(workspace_id)
);

CREATE POLICY rls_auditlog_isolation ON public.tenancy_auditlog
FOR ALL USING (
    workspace_id = public.current_tenant_workspace_id() OR public.is_member_of_workspace(workspace_id)
) WITH CHECK (
    workspace_id = public.current_tenant_workspace_id() OR public.is_member_of_workspace(workspace_id)
);

-- 3. Commerce Policies
CREATE POLICY rls_commerce_customer_isolation ON public.commerce_customer
FOR ALL USING (
    workspace_id = public.current_tenant_workspace_id() OR public.is_member_of_workspace(workspace_id)
) WITH CHECK (
    workspace_id = public.current_tenant_workspace_id() OR public.is_member_of_workspace(workspace_id)
);

CREATE POLICY rls_commerce_product_isolation ON public.commerce_product
FOR ALL USING (
    workspace_id = public.current_tenant_workspace_id() OR public.is_member_of_workspace(workspace_id)
) WITH CHECK (
    workspace_id = public.current_tenant_workspace_id() OR public.is_member_of_workspace(workspace_id)
);

CREATE POLICY rls_commerce_variant_isolation ON public.commerce_productvariant
FOR ALL USING (
    workspace_id = public.current_tenant_workspace_id() OR public.is_member_of_workspace(workspace_id)
) WITH CHECK (
    workspace_id = public.current_tenant_workspace_id() OR public.is_member_of_workspace(workspace_id)
);

CREATE POLICY rls_commerce_order_isolation ON public.commerce_order
FOR ALL USING (
    workspace_id = public.current_tenant_workspace_id() OR public.is_member_of_workspace(workspace_id)
) WITH CHECK (
    workspace_id = public.current_tenant_workspace_id() OR public.is_member_of_workspace(workspace_id)
);

CREATE POLICY rls_commerce_orderline_isolation ON public.commerce_orderline
FOR ALL USING (
    EXISTS (
        SELECT 1 FROM public.commerce_order o 
        WHERE o.id = commerce_orderline.order_id 
          AND (o.workspace_id = public.current_tenant_workspace_id() OR public.is_member_of_workspace(o.workspace_id))
    )
) WITH CHECK (
    EXISTS (
        SELECT 1 FROM public.commerce_order o 
        WHERE o.id = commerce_orderline.order_id 
          AND (o.workspace_id = public.current_tenant_workspace_id() OR public.is_member_of_workspace(o.workspace_id))
    )
);

CREATE POLICY rls_commerce_payment_isolation ON public.commerce_paymentattempt
FOR ALL USING (
    workspace_id = public.current_tenant_workspace_id() OR public.is_member_of_workspace(workspace_id)
) WITH CHECK (
    workspace_id = public.current_tenant_workspace_id() OR public.is_member_of_workspace(workspace_id)
);

CREATE POLICY rls_commerce_shipment_isolation ON public.commerce_shipment
FOR ALL USING (
    workspace_id = public.current_tenant_workspace_id() OR public.is_member_of_workspace(workspace_id)
) WITH CHECK (
    workspace_id = public.current_tenant_workspace_id() OR public.is_member_of_workspace(workspace_id)
);

CREATE POLICY rls_commerce_tracking_isolation ON public.commerce_trackingevent
FOR ALL USING (
    EXISTS (
        SELECT 1 FROM public.commerce_shipment s 
        WHERE s.id = commerce_trackingevent.shipment_id 
          AND (s.workspace_id = public.current_tenant_workspace_id() OR public.is_member_of_workspace(s.workspace_id))
    )
) WITH CHECK (
    EXISTS (
        SELECT 1 FROM public.commerce_shipment s 
        WHERE s.id = commerce_trackingevent.shipment_id 
          AND (s.workspace_id = public.current_tenant_workspace_id() OR public.is_member_of_workspace(s.workspace_id))
    )
);

CREATE POLICY rls_orderpaymentlink_isolation ON public.commerce_orderpaymentlink
FOR ALL USING (
    EXISTS (
        SELECT 1 FROM public.commerce_order o 
        WHERE o.id = commerce_orderpaymentlink.order_id 
          AND (o.workspace_id = public.current_tenant_workspace_id() OR public.is_member_of_workspace(o.workspace_id))
    )
) WITH CHECK (
    EXISTS (
        SELECT 1 FROM public.commerce_order o 
        WHERE o.id = commerce_orderpaymentlink.order_id 
          AND (o.workspace_id = public.current_tenant_workspace_id() OR public.is_member_of_workspace(o.workspace_id))
    )
);

CREATE POLICY rls_ordershipmentlink_isolation ON public.commerce_ordershipmentlink
FOR ALL USING (
    EXISTS (
        SELECT 1 FROM public.commerce_order o 
        WHERE o.id = commerce_ordershipmentlink.order_id 
          AND (o.workspace_id = public.current_tenant_workspace_id() OR public.is_member_of_workspace(o.workspace_id))
    )
) WITH CHECK (
    EXISTS (
        SELECT 1 FROM public.commerce_order o 
        WHERE o.id = commerce_ordershipmentlink.order_id 
          AND (o.workspace_id = public.current_tenant_workspace_id() OR public.is_member_of_workspace(o.workspace_id))
    )
);

-- 4. Integrations Policies
CREATE POLICY rls_integrations_isolation ON public.integrations_integration
FOR ALL USING (
    workspace_id = public.current_tenant_workspace_id() OR public.is_member_of_workspace(workspace_id)
) WITH CHECK (
    workspace_id = public.current_tenant_workspace_id() OR public.is_member_of_workspace(workspace_id)
);

CREATE POLICY rls_syncrun_isolation ON public.integrations_syncrun
FOR ALL USING (
    workspace_id = public.current_tenant_workspace_id() OR public.is_member_of_workspace(workspace_id)
) WITH CHECK (
    workspace_id = public.current_tenant_workspace_id() OR public.is_member_of_workspace(workspace_id)
);

CREATE POLICY rls_synccursor_isolation ON public.integrations_synccursor
FOR ALL USING (
    workspace_id = public.current_tenant_workspace_id() OR public.is_member_of_workspace(workspace_id)
) WITH CHECK (
    workspace_id = public.current_tenant_workspace_id() OR public.is_member_of_workspace(workspace_id)
);

CREATE POLICY rls_rawpayload_isolation ON public.integrations_rawpayload
FOR ALL USING (
    workspace_id = public.current_tenant_workspace_id() OR public.is_member_of_workspace(workspace_id)
) WITH CHECK (
    workspace_id = public.current_tenant_workspace_id() OR public.is_member_of_workspace(workspace_id)
);

CREATE POLICY rls_webhookevent_isolation ON public.integrations_webhookevent
FOR ALL USING (
    workspace_id = public.current_tenant_workspace_id() OR public.is_member_of_workspace(workspace_id)
) WITH CHECK (
    workspace_id = public.current_tenant_workspace_id() OR public.is_member_of_workspace(workspace_id)
);

-- 5. Analytics & Alerts Policies
CREATE POLICY rls_factshop_isolation ON public.analytics_factshopdaily
FOR ALL USING (
    workspace_id = public.current_tenant_workspace_id() OR public.is_member_of_workspace(workspace_id)
) WITH CHECK (
    workspace_id = public.current_tenant_workspace_id() OR public.is_member_of_workspace(workspace_id)
);

CREATE POLICY rls_factads_isolation ON public.analytics_factadsdaily
FOR ALL USING (
    workspace_id = public.current_tenant_workspace_id() OR public.is_member_of_workspace(workspace_id)
) WITH CHECK (
    workspace_id = public.current_tenant_workspace_id() OR public.is_member_of_workspace(workspace_id)
);

CREATE POLICY rls_alerts_isolation ON public.alerts_alert
FOR ALL USING (
    workspace_id = public.current_tenant_workspace_id() OR public.is_member_of_workspace(workspace_id)
) WITH CHECK (
    workspace_id = public.current_tenant_workspace_id() OR public.is_member_of_workspace(workspace_id)
);

CREATE POLICY rls_subscription_isolation ON public.billing_subscription
FOR ALL USING (
    workspace_id = public.current_tenant_workspace_id() OR public.is_member_of_workspace(workspace_id)
) WITH CHECK (
    workspace_id = public.current_tenant_workspace_id() OR public.is_member_of_workspace(workspace_id)
);
