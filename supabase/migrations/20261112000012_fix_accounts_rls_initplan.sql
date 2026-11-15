-- ============================================================================
-- Migration: 20261112000012_fix_accounts_rls_initplan.sql
-- Description: Wraps current_setting('app.user_id', TRUE) inside scalar
--   subselect (SELECT ...) on accounts_user and accounts_mfarecoverycode to
--   eliminate per-row initplan re-evaluation (lint 0003_auth_rls_initplan).
-- ============================================================================

DROP POLICY IF EXISTS rls_user_self_select ON public.accounts_user;
CREATE POLICY rls_user_self_select ON public.accounts_user
FOR SELECT TO authenticated, app_user
USING (
    id = (SELECT auth.uid())
    OR id = (SELECT NULLIF(current_setting('app.user_id', TRUE), '')::UUID)
);

DROP POLICY IF EXISTS rls_user_self_update ON public.accounts_user;
CREATE POLICY rls_user_self_update ON public.accounts_user
FOR UPDATE TO authenticated, app_user
USING (
    id = (SELECT auth.uid())
    OR id = (SELECT NULLIF(current_setting('app.user_id', TRUE), '')::UUID)
)
WITH CHECK (
    id = (SELECT auth.uid())
    OR id = (SELECT NULLIF(current_setting('app.user_id', TRUE), '')::UUID)
);

DROP POLICY IF EXISTS rls_mfarecovery_self_access ON public.accounts_mfarecoverycode;
CREATE POLICY rls_mfarecovery_self_access ON public.accounts_mfarecoverycode
FOR ALL TO authenticated, app_user
USING (
    user_id = (SELECT auth.uid())
    OR user_id = (SELECT NULLIF(current_setting('app.user_id', TRUE), '')::UUID)
)
WITH CHECK (
    user_id = (SELECT auth.uid())
    OR user_id = (SELECT NULLIF(current_setting('app.user_id', TRUE), '')::UUID)
);

INSERT INTO public._schema_migrations (version, name, execution_time_ms)
VALUES ('20261112000012', '20261112000012_fix_accounts_rls_initplan.sql', 0)
ON CONFLICT (version) DO NOTHING;
