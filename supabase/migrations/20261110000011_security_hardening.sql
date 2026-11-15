-- ============================================================================
-- Migration: 20261110000011_security_hardening.sql
-- Description: Fixes found while testing migrations 01-10 (see
--              docs/database/PHASE_3_IMPLEMENTATION.md, section "Problems found").
--   1. RLS + privilege lockdown on partition child tables
--   2. app.workspace_id GUC only trusted for the backend role (app_user)
--   3. Role-based access control (owner / admin / analyst / viewer)
--   4. Immutable audit log
--   5. Column-level protection of accounts_user / credentials
--   6. Stats / refresh functions run as caller (SECURITY INVOKER) so RLS applies
--   7. Webhook idempotency that works across partitions
--   8. search_path pinned on every SECURITY DEFINER function
-- Additive only: no table or row is dropped or deleted.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. Helper functions
-- ---------------------------------------------------------------------------

-- Backend tenant context. Only honoured for the trusted backend role, so a
-- JWT-facing role (authenticated/anon) can never self-assign a tenant by
-- running SET app.workspace_id = '<victim>'.
CREATE OR REPLACE FUNCTION public.current_tenant_workspace_id()
RETURNS UUID
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NOT (session_user = 'app_user' OR current_setting('role', TRUE) = 'app_user') THEN
        RETURN NULL;
    END IF;
    RETURN NULLIF(current_setting('app.workspace_id', TRUE), '')::UUID;
EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.is_member_of_workspace(ws_id UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT auth.uid() IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.tenancy_workspacemember
        WHERE workspace_id = ws_id AND user_id = auth.uid());
$$;

CREATE OR REPLACE FUNCTION public.has_workspace_role(ws_id UUID, roles TEXT[])
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT auth.uid() IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.tenancy_workspacemember
        WHERE workspace_id = ws_id AND user_id = auth.uid() AND role = ANY (roles));
$$;

-- ws_read: any member (or backend for this tenant)
CREATE OR REPLACE FUNCTION public.ws_read(ws_id UUID) RETURNS BOOLEAN
LANGUAGE sql STABLE SET search_path = public, pg_temp
AS $$ SELECT ws_id = public.current_tenant_workspace_id() OR public.is_member_of_workspace(ws_id) $$;

-- ws_write: owner / admin / analyst (viewer is read-only)
CREATE OR REPLACE FUNCTION public.ws_write(ws_id UUID) RETURNS BOOLEAN
LANGUAGE sql STABLE SET search_path = public, pg_temp
AS $$ SELECT ws_id = public.current_tenant_workspace_id()
          OR public.has_workspace_role(ws_id, ARRAY['owner','admin','analyst']) $$;

-- ws_admin: owner / admin
CREATE OR REPLACE FUNCTION public.ws_admin(ws_id UUID) RETURNS BOOLEAN
LANGUAGE sql STABLE SET search_path = public, pg_temp
AS $$ SELECT ws_id = public.current_tenant_workspace_id()
          OR public.has_workspace_role(ws_id, ARRAY['owner','admin']) $$;

-- ws_owner: owner only
CREATE OR REPLACE FUNCTION public.ws_owner(ws_id UUID) RETURNS BOOLEAN
LANGUAGE sql STABLE SET search_path = public, pg_temp
AS $$ SELECT ws_id = public.current_tenant_workspace_id()
          OR public.has_workspace_role(ws_id, ARRAY['owner']) $$;

-- ws_backend: trusted backend only (ingestion, billing, audit writes)
CREATE OR REPLACE FUNCTION public.ws_backend(ws_id UUID) RETURNS BOOLEAN
LANGUAGE sql STABLE SET search_path = public, pg_temp
AS $$ SELECT ws_id IS NOT NULL AND ws_id = public.current_tenant_workspace_id() $$;

CREATE OR REPLACE FUNCTION public.has_brand_access(b_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_ws_id UUID;
BEGIN
    SELECT workspace_id INTO v_ws_id FROM public.tenancy_brand WHERE id = b_id;
    IF v_ws_id IS NULL THEN RETURN FALSE; END IF;
    IF v_ws_id = public.current_tenant_workspace_id() THEN RETURN TRUE; END IF;
    IF auth.uid() IS NOT NULL AND public.is_member_of_workspace(v_ws_id) THEN
        IF NOT EXISTS (SELECT 1 FROM public.tenancy_brandmember WHERE brand_id = b_id) THEN
            RETURN TRUE;
        END IF;
        RETURN EXISTS (SELECT 1 FROM public.tenancy_brandmember
                       WHERE brand_id = b_id AND user_id = auth.uid());
    END IF;
    RETURN FALSE;
END;
$$;

-- Pin search_path on remaining SECURITY DEFINER functions
ALTER FUNCTION public.handle_new_auth_user() SET search_path = public, auth, pg_temp;

-- ---------------------------------------------------------------------------
-- 1. Partition children: RLS on + no direct client access
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.harden_partitions()
RETURNS INT LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE r RECORD; n INT := 0;
BEGIN
    FOR r IN
        SELECT c.oid::regclass AS tbl
        FROM pg_inherits i
        JOIN pg_class c ON c.oid = i.inhrelid
        JOIN pg_class p ON p.oid = i.inhparent
        WHERE p.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
    LOOP
        EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', r.tbl);
        EXECUTE format('REVOKE ALL ON %s FROM PUBLIC, anon, authenticated, app_user', r.tbl);
        n := n + 1;
    END LOOP;
    RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.harden_partitions() FROM PUBLIC, anon, authenticated;
-- Run again after creating any new monthly partition.
SELECT public.harden_partitions();

-- ---------------------------------------------------------------------------
-- 2. Replace all policies with role-aware ones
-- ---------------------------------------------------------------------------
DO $$
DECLARE p RECORD;
BEGIN
    FOR p IN SELECT schemaname, tablename, policyname FROM pg_policies WHERE schemaname = 'public' LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I', p.policyname, p.schemaname, p.tablename);
    END LOOP;
END $$;

-- Generic builder: read / write predicate on a table that has workspace_id
CREATE OR REPLACE FUNCTION public._mk_policies(tbl TEXT, read_fn TEXT, write_fn TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
    EXECUTE format('CREATE POLICY p_select ON public.%I FOR SELECT USING (public.%s(workspace_id))', tbl, read_fn);
    EXECUTE format('CREATE POLICY p_insert ON public.%I FOR INSERT WITH CHECK (public.%s(workspace_id))', tbl, write_fn);
    EXECUTE format('CREATE POLICY p_update ON public.%I FOR UPDATE USING (public.%s(workspace_id)) WITH CHECK (public.%s(workspace_id))', tbl, write_fn, write_fn);
    EXECUTE format('CREATE POLICY p_delete ON public.%I FOR DELETE USING (public.%s(workspace_id))', tbl, write_fn);
END $$;

-- Operational data: members read, owner/admin/analyst write
SELECT public._mk_policies(t, 'ws_read', 'ws_write') FROM unnest(ARRAY[
    'commerce_customer','commerce_product','commerce_productvariant','commerce_order',
    'commerce_paymentattempt','commerce_shipment','analytics_factshopdaily',
    'analytics_factadsdaily','alerts_alert','integrations_syncrun','integrations_synccursor'
]) AS t;

-- Sensitive: owner/admin read, backend-only write (ingestion pipeline)
SELECT public._mk_policies(t, 'ws_admin', 'ws_backend') FROM unnest(ARRAY[
    'integrations_integration','integrations_rawpayload','integrations_webhookevent'
]) AS t;

-- Billing: members read, backend-only write (users cannot upgrade their own plan)
SELECT public._mk_policies('billing_subscription', 'ws_read', 'ws_backend');

-- Invites: owner/admin manage
SELECT public._mk_policies('tenancy_invite', 'ws_admin', 'ws_admin');

-- Brands: members read, owner/admin write
SELECT public._mk_policies('tenancy_brand', 'ws_read', 'ws_admin');

-- Workspace row itself
CREATE POLICY p_select ON public.tenancy_workspace FOR SELECT USING (public.ws_read(id));
CREATE POLICY p_update ON public.tenancy_workspace FOR UPDATE USING (public.ws_admin(id)) WITH CHECK (public.ws_admin(id));
CREATE POLICY p_insert ON public.tenancy_workspace FOR INSERT WITH CHECK (public.ws_backend(id));
CREATE POLICY p_delete ON public.tenancy_workspace FOR DELETE USING (public.ws_owner(id));

-- Membership: only an owner can grant/touch 'owner'; admins manage lower roles.
CREATE POLICY p_select ON public.tenancy_workspacemember FOR SELECT USING (public.ws_read(workspace_id));
CREATE POLICY p_insert ON public.tenancy_workspacemember FOR INSERT WITH CHECK (
    public.ws_owner(workspace_id) OR (public.ws_admin(workspace_id) AND role <> 'owner'));
CREATE POLICY p_update ON public.tenancy_workspacemember FOR UPDATE
    USING      (public.ws_owner(workspace_id) OR (public.ws_admin(workspace_id) AND role <> 'owner'))
    WITH CHECK (public.ws_owner(workspace_id) OR (public.ws_admin(workspace_id) AND role <> 'owner'));
CREATE POLICY p_delete ON public.tenancy_workspacemember FOR DELETE USING (
    public.ws_owner(workspace_id) OR (public.ws_admin(workspace_id) AND role <> 'owner'));

CREATE POLICY p_select ON public.tenancy_brandmember FOR SELECT USING (public.has_brand_access(brand_id));
CREATE POLICY p_write  ON public.tenancy_brandmember FOR ALL
    USING      (public.ws_admin((SELECT b.workspace_id FROM public.tenancy_brand b WHERE b.id = brand_id)))
    WITH CHECK (public.ws_admin((SELECT b.workspace_id FROM public.tenancy_brand b WHERE b.id = brand_id)));

-- Audit log: owner/admin read; backend-only INSERT (no forged actors); no UPDATE/DELETE policy at all
CREATE POLICY p_select ON public.tenancy_auditlog FOR SELECT USING (public.ws_admin(workspace_id));
CREATE POLICY p_insert ON public.tenancy_auditlog FOR INSERT WITH CHECK (public.ws_backend(workspace_id));

-- Child tables inherit from their parent order / shipment
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['commerce_orderline','commerce_orderpaymentlink','commerce_ordershipmentlink'] LOOP
        EXECUTE format($f$CREATE POLICY p_select ON public.%1$I FOR SELECT USING (
            EXISTS (SELECT 1 FROM public.commerce_order o WHERE o.id = %1$I.order_id AND public.ws_read(o.workspace_id)))$f$, t);
        EXECUTE format($f$CREATE POLICY p_write ON public.%1$I FOR ALL
            USING (EXISTS (SELECT 1 FROM public.commerce_order o WHERE o.id = %1$I.order_id AND public.ws_write(o.workspace_id)))
            WITH CHECK (EXISTS (SELECT 1 FROM public.commerce_order o WHERE o.id = %1$I.order_id AND public.ws_write(o.workspace_id)))$f$, t);
    END LOOP;
END $$;
CREATE POLICY p_select ON public.commerce_trackingevent FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.commerce_shipment s WHERE s.id = commerce_trackingevent.shipment_id AND public.ws_read(s.workspace_id)));
CREATE POLICY p_write ON public.commerce_trackingevent FOR ALL
    USING (EXISTS (SELECT 1 FROM public.commerce_shipment s WHERE s.id = commerce_trackingevent.shipment_id AND public.ws_write(s.workspace_id)))
    WITH CHECK (EXISTS (SELECT 1 FROM public.commerce_shipment s WHERE s.id = commerce_trackingevent.shipment_id AND public.ws_write(s.workspace_id)));

-- Users see / edit only themselves (writable columns limited below)
CREATE POLICY p_self ON public.accounts_user FOR ALL
    USING      (id = auth.uid() OR (id = NULLIF(current_setting('app.user_id', TRUE), '')::UUID
                                    AND (session_user = 'app_user' OR current_setting('role', TRUE) = 'app_user')))
    WITH CHECK (id = auth.uid() OR (id = NULLIF(current_setting('app.user_id', TRUE), '')::UUID
                                    AND (session_user = 'app_user' OR current_setting('role', TRUE) = 'app_user')));
-- MFA recovery codes: backend only (no client policy => no client access)
CREATE POLICY p_backend ON public.accounts_mfarecoverycode FOR ALL
    USING (user_id = NULLIF(current_setting('app.user_id', TRUE), '')::UUID
           AND (session_user = 'app_user' OR current_setting('role', TRUE) = 'app_user'))
    WITH CHECK (user_id = NULLIF(current_setting('app.user_id', TRUE), '')::UUID
           AND (session_user = 'app_user' OR current_setting('role', TRUE) = 'app_user'));

-- ---------------------------------------------------------------------------
-- 3. Privileges: least privilege, column-level protection
-- ---------------------------------------------------------------------------
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
REVOKE UPDATE, DELETE ON public.tenancy_auditlog FROM authenticated, app_user;
REVOKE INSERT, DELETE ON public.accounts_user FROM authenticated;
REVOKE ALL ON public.accounts_mfarecoverycode FROM authenticated;

-- accounts_user: clients may read non-secret columns and edit only their own name
REVOKE SELECT, UPDATE ON public.accounts_user FROM authenticated;
DO $$
DECLARE cols TEXT;
BEGIN
    SELECT string_agg(quote_ident(column_name), ',') INTO cols
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'accounts_user'
      AND column_name NOT IN ('password','is_superuser','is_staff');
    EXECUTE format('GRANT SELECT (%s) ON public.accounts_user TO authenticated', cols);
    GRANT UPDATE (first_name, last_name) ON public.accounts_user TO authenticated;
END $$;

-- Integration credentials never leave the database for client roles
DO $$
DECLARE cols TEXT;
BEGIN
    REVOKE SELECT ON public.integrations_integration FROM authenticated;
    SELECT string_agg(quote_ident(column_name), ',') INTO cols
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'integrations_integration'
      AND column_name <> 'encrypted_credentials';
    EXECUTE format('GRANT SELECT (%s) ON public.integrations_integration TO authenticated', cols);
END $$;

-- Function execution
REVOKE EXECUTE ON FUNCTION public.handle_new_auth_user() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_brand_commerce_stats(UUID, UUID, INT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.refresh_daily_fact_shop(UUID, DATE) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.get_brand_commerce_stats(UUID, UUID, INT) TO authenticated, app_user;
GRANT  EXECUTE ON FUNCTION public.refresh_daily_fact_shop(UUID, DATE) TO authenticated, app_user;
GRANT  EXECUTE ON FUNCTION public.ws_read(UUID), public.ws_write(UUID), public.ws_admin(UUID),
                           public.ws_owner(UUID), public.ws_backend(UUID),
                           public.has_workspace_role(UUID, TEXT[]), public.is_member_of_workspace(UUID),
                           public.has_brand_access(UUID), public.current_tenant_workspace_id()
       TO authenticated, app_user;
REVOKE EXECUTE ON FUNCTION public.ws_read(UUID), public.ws_write(UUID), public.ws_admin(UUID),
                           public.ws_owner(UUID), public.ws_backend(UUID),
                           public.has_workspace_role(UUID, TEXT[]), public.is_member_of_workspace(UUID),
                           public.has_brand_access(UUID), public.current_tenant_workspace_id()
       FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public._mk_policies(TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Stats / refresh run as the caller so RLS decides what they may see/write
--    (previously SECURITY DEFINER + client-supplied workspace/brand ids)
-- ---------------------------------------------------------------------------
ALTER FUNCTION public.get_brand_commerce_stats(UUID, UUID, INT) SECURITY INVOKER;
ALTER FUNCTION public.get_brand_commerce_stats(UUID, UUID, INT) SET search_path = public, pg_temp;
ALTER FUNCTION public.refresh_daily_fact_shop(UUID, DATE) SECURITY INVOKER;
ALTER FUNCTION public.refresh_daily_fact_shop(UUID, DATE) SET search_path = public, pg_temp;

-- ---------------------------------------------------------------------------
-- 5. Immutable audit log (cascade deletes from a workspace delete still allowed)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.auditlog_immutable()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
    IF pg_trigger_depth() > 1 THEN   -- FK cascade from workspace removal
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'tenancy_auditlog is append-only' USING ERRCODE = 'insufficient_privilege';
END $$;
DROP TRIGGER IF EXISTS trg_auditlog_immutable ON public.tenancy_auditlog;
CREATE TRIGGER trg_auditlog_immutable BEFORE UPDATE OR DELETE ON public.tenancy_auditlog
FOR EACH ROW EXECUTE FUNCTION public.auditlog_immutable();

-- ---------------------------------------------------------------------------
-- 6. Webhook idempotency that works across partitions
--    (unique index on a partitioned table must include created_at, so the old
--     uq_webhook_idempotency never blocked a replay)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.integrations_webhookevent_dedupe (
    brand_id   UUID        NOT NULL,
    provider   VARCHAR(50) NOT NULL,
    event_id   VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (brand_id, provider, event_id)
);
ALTER TABLE public.integrations_webhookevent_dedupe ENABLE ROW LEVEL SECURITY;  -- no policies: internal only
REVOKE ALL ON public.integrations_webhookevent_dedupe FROM PUBLIC, anon, authenticated, app_user;

INSERT INTO public.integrations_webhookevent_dedupe (brand_id, provider, event_id, created_at)
SELECT brand_id, provider, event_id, MIN(created_at)
FROM public.integrations_webhookevent GROUP BY brand_id, provider, event_id
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION public.webhookevent_dedupe()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    INSERT INTO public.integrations_webhookevent_dedupe (brand_id, provider, event_id)
    VALUES (NEW.brand_id, NEW.provider, NEW.event_id)
    ON CONFLICT DO NOTHING;
    IF NOT FOUND THEN
        RETURN NULL;          -- duplicate delivery: silently skipped (same as ON CONFLICT DO NOTHING)
    END IF;
    RETURN NEW;
END $$;
REVOKE EXECUTE ON FUNCTION public.webhookevent_dedupe() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_webhookevent_dedupe ON public.integrations_webhookevent;
CREATE TRIGGER trg_webhookevent_dedupe BEFORE INSERT ON public.integrations_webhookevent
FOR EACH ROW EXECUTE FUNCTION public.webhookevent_dedupe();

-- ---------------------------------------------------------------------------
-- 7. Missing updated_at triggers on partitioned parents
-- ---------------------------------------------------------------------------
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['integrations_webhookevent','integrations_rawpayload'] LOOP
        IF EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema='public' AND table_name=t AND column_name='updated_at') THEN
            EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_updated_at ON public.%I', t, t);
            EXECUTE format('CREATE TRIGGER trg_%s_updated_at BEFORE UPDATE ON public.%I
                            FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()', t, t);
        END IF;
    END LOOP;
END $$;
