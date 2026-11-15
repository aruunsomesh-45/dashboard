-- ============================================================================
-- Migration: 20261112000013_accounts_initplan_helper.sql
-- Description: Uses a STABLE SECURITY INVOKER helper function for app.user_id
--   to clear lint 0003_auth_rls_initplan without adding SECURITY DEFINER surface.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.current_app_user_id()
RETURNS UUID AS $$
BEGIN
    RETURN NULLIF(current_setting('app.user_id', TRUE), '')::UUID;
EXCEPTION
    WHEN OTHERS THEN
        RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.current_app_user_id() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_app_user_id() TO authenticated, app_user, service_role;

DROP POLICY IF EXISTS rls_user_self_select ON public.accounts_user;
CREATE POLICY rls_user_self_select ON public.accounts_user
FOR SELECT TO authenticated, app_user
USING (
    id = (SELECT auth.uid())
    OR id = public.current_app_user_id()
);

DROP POLICY IF EXISTS rls_user_self_update ON public.accounts_user;
CREATE POLICY rls_user_self_update ON public.accounts_user
FOR UPDATE TO authenticated, app_user
USING (
    id = (SELECT auth.uid())
    OR id = public.current_app_user_id()
)
WITH CHECK (
    id = (SELECT auth.uid())
    OR id = public.current_app_user_id()
);

DROP POLICY IF EXISTS rls_mfarecovery_self_access ON public.accounts_mfarecoverycode;
CREATE POLICY rls_mfarecovery_self_access ON public.accounts_mfarecoverycode
FOR ALL TO authenticated, app_user
USING (
    user_id = (SELECT auth.uid())
    OR user_id = public.current_app_user_id()
)
WITH CHECK (
    user_id = (SELECT auth.uid())
    OR user_id = public.current_app_user_id()
);

INSERT INTO public._schema_migrations (version, name, execution_time_ms)
VALUES ('20261112000013', '20261112000013_accounts_initplan_helper.sql', 0)
ON CONFLICT (version) DO NOTHING;
