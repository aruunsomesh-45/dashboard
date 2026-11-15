-- ============================================================================
-- Migration: 20261112000011_rbac_rls_and_security_hardening.sql
-- Description: Hardens Phase 2/3 Supabase Implementation:
--   1. Pins immutable search_path on all functions & locks SECURITY DEFINER RPCs
--   2. Enforces granular Role-Based Access Control (RBAC) in RLS policies
--      (separated by SELECT / INSERT / UPDATE / DELETE to avoid permissive overlap)
--   3. Enforces immutable append-only audit logging & automated audit triggers
--   4. Applies explicit RLS policies to partitions & _schema_migrations
--   5. Optimizes auth_rls_initplan with (select auth.uid())
--   6. Adds covering indexes for all unindexed foreign keys
--   7. Attaches updated_at triggers to partitioned ingestion tables
-- ============================================================================

-- 1. Harden search_path on existing functions
ALTER FUNCTION public.set_updated_at() SET search_path = public, pg_temp;
ALTER FUNCTION public.current_tenant_workspace_id() SET search_path = public, pg_temp;
ALTER FUNCTION public.refresh_daily_fact_shop(UUID, DATE) SET search_path = public, pg_temp;
ALTER FUNCTION public.handle_new_auth_user() SET search_path = public, pg_temp;
ALTER FUNCTION public.get_brand_commerce_stats(UUID, UUID, INT) SET search_path = public, pg_temp;

-- 2. Optimized Tenant & RBAC Helper Functions (initplan-safe with (SELECT auth.uid()))
CREATE OR REPLACE FUNCTION public.is_member_of_workspace(ws_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
    v_uid UUID;
BEGIN
    v_uid := (SELECT auth.uid());
    IF v_uid IS NULL THEN
        RETURN FALSE;
    END IF;

    RETURN EXISTS (
        SELECT 1
        FROM public.tenancy_workspacemember
        WHERE workspace_id = ws_id
          AND user_id = v_uid
    );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION public.has_workspace_role(ws_id UUID, allowed_roles TEXT[])
RETURNS BOOLEAN AS $$
DECLARE
    v_uid UUID;
BEGIN
    -- Backend service / Django TenancyMiddleware context
    IF ws_id = public.current_tenant_workspace_id() THEN
        RETURN TRUE;
    END IF;

    v_uid := (SELECT auth.uid());
    IF v_uid IS NULL THEN
        RETURN FALSE;
    END IF;

    RETURN EXISTS (
        SELECT 1
        FROM public.tenancy_workspacemember
        WHERE workspace_id = ws_id
          AND user_id = v_uid
          AND role = ANY(allowed_roles)
    );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION public.has_brand_access(b_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
    v_ws_id UUID;
    v_uid UUID;
    v_role TEXT;
BEGIN
    SELECT workspace_id INTO v_ws_id FROM public.tenancy_brand WHERE id = b_id;
    IF v_ws_id IS NULL THEN
        RETURN FALSE;
    END IF;

    IF v_ws_id = public.current_tenant_workspace_id() THEN
        RETURN TRUE;
    END IF;

    v_uid := (SELECT auth.uid());
    IF v_uid IS NULL THEN
        RETURN FALSE;
    END IF;

    SELECT role INTO v_role
    FROM public.tenancy_workspacemember
    WHERE workspace_id = v_ws_id
      AND user_id = v_uid;

    IF v_role IS NULL THEN
        RETURN FALSE;
    END IF;

    -- Owners and Admins have access to all brands within their workspace
    IF v_role IN ('owner', 'admin') THEN
        RETURN TRUE;
    END IF;

    -- For analysts/viewers, check if user has explicit brand-level restrictions in this workspace
    IF NOT EXISTS (
        SELECT 1
        FROM public.tenancy_brandmember bm
        JOIN public.tenancy_brand br ON br.id = bm.brand_id
        WHERE br.workspace_id = v_ws_id
          AND bm.user_id = v_uid
    ) THEN
        RETURN TRUE;
    END IF;

    RETURN EXISTS (
        SELECT 1
        FROM public.tenancy_brandmember
        WHERE brand_id = b_id
          AND user_id = v_uid
    );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp;

-- Switch get_brand_commerce_stats to SECURITY INVOKER so RLS always applies
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
        p_workspace_id = public.current_tenant_workspace_id()
        OR public.is_member_of_workspace(p_workspace_id)
    ) THEN
        RAISE EXCEPTION 'Unauthorized workspace access';
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

-- 3. Lock Down Function Execution & Anonymous Role Table Privileges
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
REVOKE USAGE ON SCHEMA public FROM anon;

REVOKE ALL ON FUNCTION public.handle_new_auth_user() FROM PUBLIC, anon, authenticated;
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname = 'public' AND p.proname = 'rls_auto_enable'
    ) THEN
        REVOKE ALL ON FUNCTION public.rls_auto_enable() FROM PUBLIC, anon, authenticated;
    END IF;
END $$;

REVOKE ALL ON FUNCTION public.refresh_daily_fact_shop(UUID, DATE) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_daily_fact_shop(UUID, DATE) TO app_user, service_role;

REVOKE ALL ON FUNCTION public.current_tenant_workspace_id() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_tenant_workspace_id() TO authenticated, app_user, service_role;

REVOKE ALL ON FUNCTION public.is_member_of_workspace(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_member_of_workspace(UUID) TO authenticated, app_user, service_role;

REVOKE ALL ON FUNCTION public.has_workspace_role(UUID, TEXT[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_workspace_role(UUID, TEXT[]) TO authenticated, app_user, service_role;

REVOKE ALL ON FUNCTION public.has_brand_access(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_brand_access(UUID) TO authenticated, app_user, service_role;

REVOKE ALL ON FUNCTION public.get_brand_commerce_stats(UUID, UUID, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_brand_commerce_stats(UUID, UUID, INT) TO authenticated, app_user, service_role;

-- 4. Drop Legacy Blanket FOR ALL Policies
DROP POLICY IF EXISTS rls_user_self_access ON public.accounts_user;
DROP POLICY IF EXISTS rls_mfarecovery_self_access ON public.accounts_mfarecoverycode;
DROP POLICY IF EXISTS rls_workspace_isolation ON public.tenancy_workspace;
DROP POLICY IF EXISTS rls_workspacemember_isolation ON public.tenancy_workspacemember;
DROP POLICY IF EXISTS rls_brand_isolation ON public.tenancy_brand;
DROP POLICY IF EXISTS rls_brandmember_isolation ON public.tenancy_brandmember;
DROP POLICY IF EXISTS rls_invite_isolation ON public.tenancy_invite;
DROP POLICY IF EXISTS rls_auditlog_isolation ON public.tenancy_auditlog;
DROP POLICY IF EXISTS rls_commerce_customer_isolation ON public.commerce_customer;
DROP POLICY IF EXISTS rls_commerce_product_isolation ON public.commerce_product;
DROP POLICY IF EXISTS rls_commerce_variant_isolation ON public.commerce_productvariant;
DROP POLICY IF EXISTS rls_commerce_order_isolation ON public.commerce_order;
DROP POLICY IF EXISTS rls_commerce_orderline_isolation ON public.commerce_orderline;
DROP POLICY IF EXISTS rls_commerce_payment_isolation ON public.commerce_paymentattempt;
DROP POLICY IF EXISTS rls_commerce_shipment_isolation ON public.commerce_shipment;
DROP POLICY IF EXISTS rls_commerce_tracking_isolation ON public.commerce_trackingevent;
DROP POLICY IF EXISTS rls_orderpaymentlink_isolation ON public.commerce_orderpaymentlink;
DROP POLICY IF EXISTS rls_ordershipmentlink_isolation ON public.commerce_ordershipmentlink;
DROP POLICY IF EXISTS rls_integrations_isolation ON public.integrations_integration;
DROP POLICY IF EXISTS rls_syncrun_isolation ON public.integrations_syncrun;
DROP POLICY IF EXISTS rls_synccursor_isolation ON public.integrations_synccursor;
DROP POLICY IF EXISTS rls_rawpayload_isolation ON public.integrations_rawpayload;
DROP POLICY IF EXISTS rls_webhookevent_isolation ON public.integrations_webhookevent;
DROP POLICY IF EXISTS rls_factshop_isolation ON public.analytics_factshopdaily;
DROP POLICY IF EXISTS rls_factads_isolation ON public.analytics_factadsdaily;
DROP POLICY IF EXISTS rls_alerts_isolation ON public.alerts_alert;
DROP POLICY IF EXISTS rls_subscription_isolation ON public.billing_subscription;

-- 4.1 Internal Migration Table Policy (Explicit Client Deny)
DROP POLICY IF EXISTS rls_migrations_deny_client ON public._schema_migrations;
CREATE POLICY rls_migrations_deny_client ON public._schema_migrations
FOR ALL TO authenticated, app_user USING (FALSE) WITH CHECK (FALSE);

-- 4.2 Accounts Domain (initplan-safe (SELECT auth.uid()))
CREATE POLICY rls_user_self_select ON public.accounts_user
FOR SELECT TO authenticated, app_user
USING (
    id = (SELECT auth.uid())
    OR id = NULLIF(current_setting('app.user_id', TRUE), '')::UUID
);

CREATE POLICY rls_user_self_update ON public.accounts_user
FOR UPDATE TO authenticated, app_user
USING (
    id = (SELECT auth.uid())
    OR id = NULLIF(current_setting('app.user_id', TRUE), '')::UUID
)
WITH CHECK (
    id = (SELECT auth.uid())
    OR id = NULLIF(current_setting('app.user_id', TRUE), '')::UUID
);

CREATE POLICY rls_mfarecovery_self_access ON public.accounts_mfarecoverycode
FOR ALL TO authenticated, app_user
USING (
    user_id = (SELECT auth.uid())
    OR user_id = NULLIF(current_setting('app.user_id', TRUE), '')::UUID
)
WITH CHECK (
    user_id = (SELECT auth.uid())
    OR user_id = NULLIF(current_setting('app.user_id', TRUE), '')::UUID
);

-- 4.3 Tenancy Domain (Strict Organization Isolation + RBAC)
CREATE POLICY rls_workspace_select ON public.tenancy_workspace
FOR SELECT TO authenticated, app_user
USING (id = public.current_tenant_workspace_id() OR public.is_member_of_workspace(id));

CREATE POLICY rls_workspace_update ON public.tenancy_workspace
FOR UPDATE TO authenticated, app_user
USING (public.has_workspace_role(id, ARRAY['owner', 'admin']))
WITH CHECK (public.has_workspace_role(id, ARRAY['owner', 'admin']));

CREATE POLICY rls_workspace_delete ON public.tenancy_workspace
FOR DELETE TO authenticated, app_user
USING (public.has_workspace_role(id, ARRAY['owner']));

CREATE POLICY rls_workspacemember_select ON public.tenancy_workspacemember
FOR SELECT TO authenticated, app_user
USING (workspace_id = public.current_tenant_workspace_id() OR public.is_member_of_workspace(workspace_id));

CREATE POLICY rls_workspacemember_insert ON public.tenancy_workspacemember
FOR INSERT TO authenticated, app_user
WITH CHECK (
    workspace_id = public.current_tenant_workspace_id()
    OR (
        public.has_workspace_role(workspace_id, ARRAY['owner', 'admin'])
        AND (role <> 'owner' OR public.has_workspace_role(workspace_id, ARRAY['owner']))
    )
);

CREATE POLICY rls_workspacemember_update ON public.tenancy_workspacemember
FOR UPDATE TO authenticated, app_user
USING (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin']))
WITH CHECK (
    workspace_id = public.current_tenant_workspace_id()
    OR (
        public.has_workspace_role(workspace_id, ARRAY['owner', 'admin'])
        AND (role <> 'owner' OR public.has_workspace_role(workspace_id, ARRAY['owner']))
    )
);

CREATE POLICY rls_workspacemember_delete ON public.tenancy_workspacemember
FOR DELETE TO authenticated, app_user
USING (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin']));

CREATE POLICY rls_brand_select ON public.tenancy_brand
FOR SELECT TO authenticated, app_user
USING (workspace_id = public.current_tenant_workspace_id() OR public.is_member_of_workspace(workspace_id));

CREATE POLICY rls_brand_insert ON public.tenancy_brand
FOR INSERT TO authenticated, app_user
WITH CHECK (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin']));

CREATE POLICY rls_brand_update ON public.tenancy_brand
FOR UPDATE TO authenticated, app_user
USING (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin']))
WITH CHECK (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin']));

CREATE POLICY rls_brand_delete ON public.tenancy_brand
FOR DELETE TO authenticated, app_user
USING (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin']));

CREATE POLICY rls_brandmember_select ON public.tenancy_brandmember
FOR SELECT TO authenticated, app_user
USING (public.has_brand_access(brand_id));

CREATE POLICY rls_brandmember_insert ON public.tenancy_brandmember
FOR INSERT TO authenticated, app_user
WITH CHECK (
    EXISTS (
        SELECT 1 FROM public.tenancy_brand b
        WHERE b.id = tenancy_brandmember.brand_id
          AND public.has_workspace_role(b.workspace_id, ARRAY['owner', 'admin'])
    )
);

CREATE POLICY rls_brandmember_update ON public.tenancy_brandmember
FOR UPDATE TO authenticated, app_user
USING (
    EXISTS (
        SELECT 1 FROM public.tenancy_brand b
        WHERE b.id = tenancy_brandmember.brand_id
          AND public.has_workspace_role(b.workspace_id, ARRAY['owner', 'admin'])
    )
)
WITH CHECK (
    EXISTS (
        SELECT 1 FROM public.tenancy_brand b
        WHERE b.id = tenancy_brandmember.brand_id
          AND public.has_workspace_role(b.workspace_id, ARRAY['owner', 'admin'])
    )
);

CREATE POLICY rls_brandmember_delete ON public.tenancy_brandmember
FOR DELETE TO authenticated, app_user
USING (
    EXISTS (
        SELECT 1 FROM public.tenancy_brand b
        WHERE b.id = tenancy_brandmember.brand_id
          AND public.has_workspace_role(b.workspace_id, ARRAY['owner', 'admin'])
    )
);

CREATE POLICY rls_invite_select ON public.tenancy_invite
FOR SELECT TO authenticated, app_user
USING (workspace_id = public.current_tenant_workspace_id() OR public.has_workspace_role(workspace_id, ARRAY['owner', 'admin']));

CREATE POLICY rls_invite_insert ON public.tenancy_invite
FOR INSERT TO authenticated, app_user
WITH CHECK (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin']));

CREATE POLICY rls_invite_update ON public.tenancy_invite
FOR UPDATE TO authenticated, app_user
USING (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin']))
WITH CHECK (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin']));

CREATE POLICY rls_invite_delete ON public.tenancy_invite
FOR DELETE TO authenticated, app_user
USING (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin']));

-- Audit log is strictly APPEND-ONLY (SELECT for owner/admin/analyst; INSERT only; NO UPDATE/DELETE)
CREATE POLICY rls_auditlog_select ON public.tenancy_auditlog
FOR SELECT TO authenticated, app_user
USING (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin', 'analyst']));

CREATE POLICY rls_auditlog_insert ON public.tenancy_auditlog
FOR INSERT TO authenticated, app_user
WITH CHECK (
    workspace_id = public.current_tenant_workspace_id()
    OR (
        public.is_member_of_workspace(workspace_id)
        AND (actor_id IS NULL OR actor_id = (SELECT auth.uid()))
    )
);

-- 4.4 Billing Domain
CREATE POLICY rls_subscription_select ON public.billing_subscription
FOR SELECT TO authenticated, app_user
USING (workspace_id = public.current_tenant_workspace_id() OR public.is_member_of_workspace(workspace_id));

CREATE POLICY rls_subscription_insert ON public.billing_subscription
FOR INSERT TO authenticated, app_user
WITH CHECK (public.has_workspace_role(workspace_id, ARRAY['owner']));

CREATE POLICY rls_subscription_update ON public.billing_subscription
FOR UPDATE TO authenticated, app_user
USING (public.has_workspace_role(workspace_id, ARRAY['owner']))
WITH CHECK (public.has_workspace_role(workspace_id, ARRAY['owner']));

CREATE POLICY rls_subscription_delete ON public.billing_subscription
FOR DELETE TO authenticated, app_user
USING (public.has_workspace_role(workspace_id, ARRAY['owner']));

-- 4.5 Homogeneous Workspace-Scoped Operational & Partition Tables
DO $$
DECLARE
    v_tbl TEXT;
    v_ws_tables TEXT[] := ARRAY[
        'integrations_integration',
        'integrations_syncrun',
        'integrations_synccursor'
    ];
    v_part_tables TEXT[] := ARRAY[
        'integrations_rawpayload',
        'rawpayload_default', 'rawpayload_2026_10', 'rawpayload_2026_11', 'rawpayload_2026_12',
        'integrations_webhookevent',
        'webhookevent_default', 'webhookevent_2026_10', 'webhookevent_2026_11', 'webhookevent_2026_12'
    ];
    v_brand_tables TEXT[] := ARRAY[
        'commerce_customer',
        'commerce_product',
        'commerce_productvariant',
        'commerce_order',
        'commerce_paymentattempt',
        'commerce_shipment',
        'analytics_factshopdaily',
        'analytics_factadsdaily'
    ];
BEGIN
    FOREACH v_tbl IN ARRAY v_ws_tables LOOP
        EXECUTE format('DROP POLICY IF EXISTS rls_%s_select ON public.%I;', v_tbl, v_tbl);
        EXECUTE format('DROP POLICY IF EXISTS rls_%s_insert ON public.%I;', v_tbl, v_tbl);
        EXECUTE format('DROP POLICY IF EXISTS rls_%s_update ON public.%I;', v_tbl, v_tbl);
        EXECUTE format('DROP POLICY IF EXISTS rls_%s_delete ON public.%I;', v_tbl, v_tbl);

        EXECUTE format(
            'CREATE POLICY rls_%s_select ON public.%I FOR SELECT TO authenticated, app_user USING (workspace_id = public.current_tenant_workspace_id() OR public.is_member_of_workspace(workspace_id));',
            v_tbl, v_tbl
        );
        EXECUTE format(
            'CREATE POLICY rls_%s_insert ON public.%I FOR INSERT TO authenticated, app_user WITH CHECK (public.has_workspace_role(%I.workspace_id, ARRAY[''owner'', ''admin'']) AND EXISTS (SELECT 1 FROM public.tenancy_brand b WHERE b.id = %I.brand_id AND b.workspace_id = %I.workspace_id));',
            v_tbl, v_tbl, v_tbl, v_tbl, v_tbl
        );
        EXECUTE format(
            'CREATE POLICY rls_%s_update ON public.%I FOR UPDATE TO authenticated, app_user USING (public.has_workspace_role(%I.workspace_id, ARRAY[''owner'', ''admin''])) WITH CHECK (public.has_workspace_role(%I.workspace_id, ARRAY[''owner'', ''admin'']) AND EXISTS (SELECT 1 FROM public.tenancy_brand b WHERE b.id = %I.brand_id AND b.workspace_id = %I.workspace_id));',
            v_tbl, v_tbl, v_tbl, v_tbl, v_tbl, v_tbl
        );
        EXECUTE format(
            'CREATE POLICY rls_%s_delete ON public.%I FOR DELETE TO authenticated, app_user USING (public.has_workspace_role(workspace_id, ARRAY[''owner'', ''admin'']));',
            v_tbl, v_tbl
        );
    END LOOP;

    FOREACH v_tbl IN ARRAY v_part_tables LOOP
        EXECUTE format('DROP POLICY IF EXISTS rls_%s_select ON public.%I;', v_tbl, v_tbl);
        EXECUTE format('DROP POLICY IF EXISTS rls_%s_insert ON public.%I;', v_tbl, v_tbl);
        EXECUTE format('DROP POLICY IF EXISTS rls_%s_update ON public.%I;', v_tbl, v_tbl);
        EXECUTE format('DROP POLICY IF EXISTS rls_%s_delete ON public.%I;', v_tbl, v_tbl);

        EXECUTE format(
            'CREATE POLICY rls_%s_select ON public.%I FOR SELECT TO authenticated, app_user USING (workspace_id = public.current_tenant_workspace_id() OR public.has_workspace_role(workspace_id, ARRAY[''owner'', ''admin'', ''analyst'']));',
            v_tbl, v_tbl
        );
        EXECUTE format(
            'CREATE POLICY rls_%s_insert ON public.%I FOR INSERT TO authenticated, app_user WITH CHECK (public.has_workspace_role(%I.workspace_id, ARRAY[''owner'', ''admin'']) AND EXISTS (SELECT 1 FROM public.tenancy_brand b WHERE b.id = %I.brand_id AND b.workspace_id = %I.workspace_id));',
            v_tbl, v_tbl, v_tbl, v_tbl, v_tbl
        );
        EXECUTE format(
            'CREATE POLICY rls_%s_update ON public.%I FOR UPDATE TO authenticated, app_user USING (public.has_workspace_role(%I.workspace_id, ARRAY[''owner'', ''admin''])) WITH CHECK (public.has_workspace_role(%I.workspace_id, ARRAY[''owner'', ''admin'']) AND EXISTS (SELECT 1 FROM public.tenancy_brand b WHERE b.id = %I.brand_id AND b.workspace_id = %I.workspace_id));',
            v_tbl, v_tbl, v_tbl, v_tbl, v_tbl, v_tbl
        );
        EXECUTE format(
            'CREATE POLICY rls_%s_delete ON public.%I FOR DELETE TO authenticated, app_user USING (public.has_workspace_role(workspace_id, ARRAY[''owner'', ''admin'']));',
            v_tbl, v_tbl
        );
    END LOOP;

    FOREACH v_tbl IN ARRAY v_brand_tables LOOP
        EXECUTE format('DROP POLICY IF EXISTS rls_%s_select ON public.%I;', v_tbl, v_tbl);
        EXECUTE format('DROP POLICY IF EXISTS rls_%s_insert ON public.%I;', v_tbl, v_tbl);
        EXECUTE format('DROP POLICY IF EXISTS rls_%s_update ON public.%I;', v_tbl, v_tbl);
        EXECUTE format('DROP POLICY IF EXISTS rls_%s_delete ON public.%I;', v_tbl, v_tbl);

        EXECUTE format(
            'CREATE POLICY rls_%s_select ON public.%I FOR SELECT TO authenticated, app_user USING (public.has_brand_access(brand_id));',
            v_tbl, v_tbl
        );
        EXECUTE format(
            'CREATE POLICY rls_%s_insert ON public.%I FOR INSERT TO authenticated, app_user WITH CHECK (public.has_workspace_role(%I.workspace_id, ARRAY[''owner'', ''admin'']) AND EXISTS (SELECT 1 FROM public.tenancy_brand b WHERE b.id = %I.brand_id AND b.workspace_id = %I.workspace_id));',
            v_tbl, v_tbl, v_tbl, v_tbl, v_tbl
        );
        EXECUTE format(
            'CREATE POLICY rls_%s_update ON public.%I FOR UPDATE TO authenticated, app_user USING (public.has_workspace_role(%I.workspace_id, ARRAY[''owner'', ''admin''])) WITH CHECK (public.has_workspace_role(%I.workspace_id, ARRAY[''owner'', ''admin'']) AND EXISTS (SELECT 1 FROM public.tenancy_brand b WHERE b.id = %I.brand_id AND b.workspace_id = %I.workspace_id));',
            v_tbl, v_tbl, v_tbl, v_tbl, v_tbl, v_tbl
        );
        EXECUTE format(
            'CREATE POLICY rls_%s_delete ON public.%I FOR DELETE TO authenticated, app_user USING (public.has_workspace_role(workspace_id, ARRAY[''owner'', ''admin'']));',
            v_tbl, v_tbl
        );
    END LOOP;
END $$;

-- 4.6 Child Junction Tables (Order Lines, Tracking Events, Reconciliation Links)
CREATE POLICY rls_commerce_orderline_select ON public.commerce_orderline
FOR SELECT TO authenticated, app_user
USING (EXISTS (SELECT 1 FROM public.commerce_order o WHERE o.id = commerce_orderline.order_id AND public.has_brand_access(o.brand_id)));

CREATE POLICY rls_commerce_orderline_insert ON public.commerce_orderline
FOR INSERT TO authenticated, app_user
WITH CHECK (EXISTS (SELECT 1 FROM public.commerce_order o WHERE o.id = commerce_orderline.order_id AND public.has_workspace_role(o.workspace_id, ARRAY['owner', 'admin'])));

CREATE POLICY rls_commerce_orderline_update ON public.commerce_orderline
FOR UPDATE TO authenticated, app_user
USING (EXISTS (SELECT 1 FROM public.commerce_order o WHERE o.id = commerce_orderline.order_id AND public.has_workspace_role(o.workspace_id, ARRAY['owner', 'admin'])))
WITH CHECK (EXISTS (SELECT 1 FROM public.commerce_order o WHERE o.id = commerce_orderline.order_id AND public.has_workspace_role(o.workspace_id, ARRAY['owner', 'admin'])));

CREATE POLICY rls_commerce_orderline_delete ON public.commerce_orderline
FOR DELETE TO authenticated, app_user
USING (EXISTS (SELECT 1 FROM public.commerce_order o WHERE o.id = commerce_orderline.order_id AND public.has_workspace_role(o.workspace_id, ARRAY['owner', 'admin'])));

CREATE POLICY rls_commerce_tracking_select ON public.commerce_trackingevent
FOR SELECT TO authenticated, app_user
USING (EXISTS (SELECT 1 FROM public.commerce_shipment s WHERE s.id = commerce_trackingevent.shipment_id AND public.has_brand_access(s.brand_id)));

CREATE POLICY rls_commerce_tracking_insert ON public.commerce_trackingevent
FOR INSERT TO authenticated, app_user
WITH CHECK (EXISTS (SELECT 1 FROM public.commerce_shipment s WHERE s.id = commerce_trackingevent.shipment_id AND public.has_workspace_role(s.workspace_id, ARRAY['owner', 'admin'])));

CREATE POLICY rls_commerce_tracking_update ON public.commerce_trackingevent
FOR UPDATE TO authenticated, app_user
USING (EXISTS (SELECT 1 FROM public.commerce_shipment s WHERE s.id = commerce_trackingevent.shipment_id AND public.has_workspace_role(s.workspace_id, ARRAY['owner', 'admin'])))
WITH CHECK (EXISTS (SELECT 1 FROM public.commerce_shipment s WHERE s.id = commerce_trackingevent.shipment_id AND public.has_workspace_role(s.workspace_id, ARRAY['owner', 'admin'])));

CREATE POLICY rls_commerce_tracking_delete ON public.commerce_trackingevent
FOR DELETE TO authenticated, app_user
USING (EXISTS (SELECT 1 FROM public.commerce_shipment s WHERE s.id = commerce_trackingevent.shipment_id AND public.has_workspace_role(s.workspace_id, ARRAY['owner', 'admin'])));

CREATE POLICY rls_orderpaymentlink_select ON public.commerce_orderpaymentlink
FOR SELECT TO authenticated, app_user
USING (EXISTS (SELECT 1 FROM public.commerce_order o WHERE o.id = commerce_orderpaymentlink.order_id AND public.has_brand_access(o.brand_id)));

CREATE POLICY rls_orderpaymentlink_insert ON public.commerce_orderpaymentlink
FOR INSERT TO authenticated, app_user
WITH CHECK (EXISTS (SELECT 1 FROM public.commerce_order o WHERE o.id = commerce_orderpaymentlink.order_id AND public.has_workspace_role(o.workspace_id, ARRAY['owner', 'admin'])));

CREATE POLICY rls_orderpaymentlink_update ON public.commerce_orderpaymentlink
FOR UPDATE TO authenticated, app_user
USING (EXISTS (SELECT 1 FROM public.commerce_order o WHERE o.id = commerce_orderpaymentlink.order_id AND public.has_workspace_role(o.workspace_id, ARRAY['owner', 'admin'])))
WITH CHECK (EXISTS (SELECT 1 FROM public.commerce_order o WHERE o.id = commerce_orderpaymentlink.order_id AND public.has_workspace_role(o.workspace_id, ARRAY['owner', 'admin'])));

CREATE POLICY rls_orderpaymentlink_delete ON public.commerce_orderpaymentlink
FOR DELETE TO authenticated, app_user
USING (EXISTS (SELECT 1 FROM public.commerce_order o WHERE o.id = commerce_orderpaymentlink.order_id AND public.has_workspace_role(o.workspace_id, ARRAY['owner', 'admin'])));

CREATE POLICY rls_ordershipmentlink_select ON public.commerce_ordershipmentlink
FOR SELECT TO authenticated, app_user
USING (EXISTS (SELECT 1 FROM public.commerce_order o WHERE o.id = commerce_ordershipmentlink.order_id AND public.has_brand_access(o.brand_id)));

CREATE POLICY rls_ordershipmentlink_insert ON public.commerce_ordershipmentlink
FOR INSERT TO authenticated, app_user
WITH CHECK (EXISTS (SELECT 1 FROM public.commerce_order o WHERE o.id = commerce_ordershipmentlink.order_id AND public.has_workspace_role(o.workspace_id, ARRAY['owner', 'admin'])));

CREATE POLICY rls_ordershipmentlink_update ON public.commerce_ordershipmentlink
FOR UPDATE TO authenticated, app_user
USING (EXISTS (SELECT 1 FROM public.commerce_order o WHERE o.id = commerce_ordershipmentlink.order_id AND public.has_workspace_role(o.workspace_id, ARRAY['owner', 'admin'])))
WITH CHECK (EXISTS (SELECT 1 FROM public.commerce_order o WHERE o.id = commerce_ordershipmentlink.order_id AND public.has_workspace_role(o.workspace_id, ARRAY['owner', 'admin'])));

CREATE POLICY rls_ordershipmentlink_delete ON public.commerce_ordershipmentlink
FOR DELETE TO authenticated, app_user
USING (EXISTS (SELECT 1 FROM public.commerce_order o WHERE o.id = commerce_ordershipmentlink.order_id AND public.has_workspace_role(o.workspace_id, ARRAY['owner', 'admin'])));

-- 4.7 Alerts Domain (Analysts can acknowledge/resolve alerts; Viewers read-only)
CREATE POLICY rls_alerts_select ON public.alerts_alert
FOR SELECT TO authenticated, app_user
USING (public.has_brand_access(brand_id));

CREATE POLICY rls_alerts_insert ON public.alerts_alert
FOR INSERT TO authenticated, app_user
WITH CHECK (
    public.has_workspace_role(alerts_alert.workspace_id, ARRAY['owner', 'admin'])
    AND EXISTS (SELECT 1 FROM public.tenancy_brand b WHERE b.id = alerts_alert.brand_id AND b.workspace_id = alerts_alert.workspace_id)
);

CREATE POLICY rls_alerts_update ON public.alerts_alert
FOR UPDATE TO authenticated, app_user
USING (public.has_workspace_role(alerts_alert.workspace_id, ARRAY['owner', 'admin', 'analyst']))
WITH CHECK (
    public.has_workspace_role(alerts_alert.workspace_id, ARRAY['owner', 'admin', 'analyst'])
    AND EXISTS (SELECT 1 FROM public.tenancy_brand b WHERE b.id = alerts_alert.brand_id AND b.workspace_id = alerts_alert.workspace_id)
);

CREATE POLICY rls_alerts_delete ON public.alerts_alert
FOR DELETE TO authenticated, app_user
USING (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin']));

-- 5. Attach Missing updated_at Triggers to Partitioned Ingestion Tables
DROP TRIGGER IF EXISTS trg_integrations_rawpayload_updated_at ON public.integrations_rawpayload;
CREATE TRIGGER trg_integrations_rawpayload_updated_at
BEFORE UPDATE ON public.integrations_rawpayload
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_integrations_webhookevent_updated_at ON public.integrations_webhookevent;
CREATE TRIGGER trg_integrations_webhookevent_updated_at
BEFORE UPDATE ON public.integrations_webhookevent
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 6. Automated Database Security Audit Trigger for Critical RBAC & Integration Events
CREATE OR REPLACE FUNCTION public.log_security_audit_event()
RETURNS TRIGGER AS $$
DECLARE
    v_ws_id UUID;
    v_actor_id UUID;
    v_action VARCHAR(100);
    v_target VARCHAR(255);
    v_meta JSONB;
BEGIN
    v_actor_id := COALESCE(
        (SELECT auth.uid()),
        NULLIF(current_setting('app.user_id', TRUE), '')::UUID
    );

    IF TG_TABLE_NAME = 'tenancy_workspacemember' THEN
        v_ws_id := COALESCE(NEW.workspace_id, OLD.workspace_id);
        IF TG_OP = 'INSERT' THEN
            v_action := 'member.added';
            v_target := NEW.user_id::text;
            v_meta := jsonb_build_object('role', NEW.role);
        ELSIF TG_OP = 'UPDATE' THEN
            IF OLD.role = NEW.role THEN
                RETURN NEW;
            END IF;
            v_action := 'member.role_updated';
            v_target := NEW.user_id::text;
            v_meta := jsonb_build_object('old_role', OLD.role, 'new_role', NEW.role);
        ELSIF TG_OP = 'DELETE' THEN
            v_action := 'member.removed';
            v_target := OLD.user_id::text;
            v_meta := jsonb_build_object('old_role', OLD.role);
        END IF;
    ELSIF TG_TABLE_NAME = 'integrations_integration' THEN
        v_ws_id := COALESCE(NEW.workspace_id, OLD.workspace_id);
        IF TG_OP = 'INSERT' THEN
            v_action := 'integration.created';
            v_target := NEW.provider || ':' || NEW.brand_id::text;
            v_meta := jsonb_build_object('provider', NEW.provider, 'status', NEW.status);
        ELSIF TG_OP = 'UPDATE' THEN
            IF OLD.status = NEW.status AND OLD.account_identifier = NEW.account_identifier THEN
                RETURN NEW;
            END IF;
            v_action := 'integration.updated';
            v_target := NEW.provider || ':' || NEW.brand_id::text;
            v_meta := jsonb_build_object('old_status', OLD.status, 'new_status', NEW.status);
        ELSIF TG_OP = 'DELETE' THEN
            v_action := 'integration.deleted';
            v_target := OLD.provider || ':' || OLD.brand_id::text;
            v_meta := jsonb_build_object('provider', OLD.provider);
        END IF;
    END IF;

    -- Guard against cascading workspace deletions
    IF v_ws_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.tenancy_workspace WHERE id = v_ws_id) THEN
        IF v_actor_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.accounts_user WHERE id = v_actor_id) THEN
            v_actor_id := NULL;
        END IF;

        INSERT INTO public.tenancy_auditlog (workspace_id, actor_id, action, target, metadata)
        VALUES (v_ws_id, v_actor_id, v_action, COALESCE(v_target, ''), COALESCE(v_meta, '{}'::jsonb));
    END IF;

    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.log_security_audit_event() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_audit_workspacemember ON public.tenancy_workspacemember;
CREATE TRIGGER trg_audit_workspacemember
AFTER INSERT OR UPDATE OR DELETE ON public.tenancy_workspacemember
FOR EACH ROW EXECUTE FUNCTION public.log_security_audit_event();

DROP TRIGGER IF EXISTS trg_audit_integration ON public.integrations_integration;
CREATE TRIGGER trg_audit_integration
AFTER INSERT OR UPDATE OR DELETE ON public.integrations_integration
FOR EACH ROW EXECUTE FUNCTION public.log_security_audit_event();

-- 7. Covering Indexes for Unindexed Foreign Keys (Fixes 0001_unindexed_foreign_keys)
CREATE INDEX IF NOT EXISTS idx_alerts_acknowledged_by ON public.alerts_alert (acknowledged_by_id);
CREATE INDEX IF NOT EXISTS idx_factads_workspace ON public.analytics_factadsdaily (workspace_id);
CREATE INDEX IF NOT EXISTS idx_factshop_workspace ON public.analytics_factshopdaily (workspace_id);
CREATE INDEX IF NOT EXISTS idx_commerce_customer_workspace ON public.commerce_customer (workspace_id);
CREATE INDEX IF NOT EXISTS idx_commerce_order_workspace ON public.commerce_order (workspace_id);
CREATE INDEX IF NOT EXISTS idx_commerce_orderline_variant ON public.commerce_orderline (variant_id);
CREATE INDEX IF NOT EXISTS idx_orderpaymentlink_payment ON public.commerce_orderpaymentlink (payment_attempt_id);
CREATE INDEX IF NOT EXISTS idx_ordershipmentlink_shipment ON public.commerce_ordershipmentlink (shipment_id);
CREATE INDEX IF NOT EXISTS idx_commerce_payment_workspace ON public.commerce_paymentattempt (workspace_id);
CREATE INDEX IF NOT EXISTS idx_commerce_product_workspace ON public.commerce_product (workspace_id);
CREATE INDEX IF NOT EXISTS idx_commerce_variant_product ON public.commerce_productvariant (product_id);
CREATE INDEX IF NOT EXISTS idx_commerce_variant_workspace ON public.commerce_productvariant (workspace_id);
CREATE INDEX IF NOT EXISTS idx_commerce_shipment_workspace ON public.commerce_shipment (workspace_id);
CREATE INDEX IF NOT EXISTS idx_integration_workspace ON public.integrations_integration (workspace_id);
CREATE INDEX IF NOT EXISTS idx_rawpayload_workspace ON public.integrations_rawpayload (workspace_id);
CREATE INDEX IF NOT EXISTS idx_synccursor_brand ON public.integrations_synccursor (brand_id);
CREATE INDEX IF NOT EXISTS idx_synccursor_workspace ON public.integrations_synccursor (workspace_id);
CREATE INDEX IF NOT EXISTS idx_syncrun_brand ON public.integrations_syncrun (brand_id);
CREATE INDEX IF NOT EXISTS idx_syncrun_integration ON public.integrations_syncrun (integration_id);
CREATE INDEX IF NOT EXISTS idx_syncrun_workspace ON public.integrations_syncrun (workspace_id);
CREATE INDEX IF NOT EXISTS idx_webhookevent_workspace ON public.integrations_webhookevent (workspace_id);
CREATE INDEX IF NOT EXISTS idx_auditlog_actor ON public.tenancy_auditlog (actor_id);
CREATE INDEX IF NOT EXISTS idx_brandmember_user ON public.tenancy_brandmember (user_id);
CREATE INDEX IF NOT EXISTS idx_invite_created_by ON public.tenancy_invite (created_by_id);
CREATE INDEX IF NOT EXISTS idx_invite_workspace ON public.tenancy_invite (workspace_id);

-- Record in custom _schema_migrations tracker as well
INSERT INTO public._schema_migrations (version, name, execution_time_ms)
VALUES ('20261112000011', '20261112000011_rbac_rls_and_security_hardening.sql', 0)
ON CONFLICT (version) DO NOTHING;
