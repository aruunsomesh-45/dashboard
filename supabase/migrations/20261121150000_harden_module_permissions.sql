-- ============================================================================
-- Migration: 20261121150000_harden_module_permissions.sql
-- Description: Close gaps left by 20261121134000_super_admin_module_permissions.sql
--
-- 1. The four new tables were created without ENABLE ROW LEVEL SECURITY. The hosted project
--    happens to be protected by the `ensure_rls` event trigger (RLS on, no policies => deny-all
--    for anon/authenticated), but a database built from these migrations alone (local, staging,
--    disaster-recovery restore) would expose user_module_permissions / admin_audit_logs to every
--    signed-in user through PostgREST. Enable RLS explicitly; all writes go through the
--    service-role Next.js super-admin API, which bypasses RLS.
-- 2. platform_modules is a read-only catalogue: authenticated users may read it.
-- 3. is_super_admin(uuid) and get_user_effective_modules(uuid, uuid) are SECURITY DEFINER and were
--    executable by `anon`, letting anyone probe whether an arbitrary user id is a super admin, or
--    read another user's module overrides. Revoke from PUBLIC/anon and make the module function
--    refuse to answer for a different user unless the caller is a super admin. Server-side
--    callers (service_role, Django app_user) have auth.uid() = NULL and are unaffected.
--
-- Idempotent and non-destructive: no data is modified.
-- ============================================================================

ALTER TABLE public.platform_modules             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_module_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_module_permissions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_audit_logs             ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_platform_modules_read ON public.platform_modules;
CREATE POLICY rls_platform_modules_read ON public.platform_modules
    FOR SELECT TO authenticated
    USING (true);

-- Only the service role (super-admin API) writes these tables.
REVOKE INSERT, UPDATE, DELETE ON public.platform_modules             FROM anon, authenticated;
REVOKE ALL                    ON public.workspace_module_permissions FROM anon, authenticated;
REVOKE ALL                    ON public.user_module_permissions      FROM anon, authenticated;
REVOKE ALL                    ON public.admin_audit_logs             FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.get_user_effective_modules(p_user_id UUID, p_workspace_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_caller UUID := auth.uid();
    is_super BOOLEAN;
    result JSONB := '{}'::jsonb;
    mod RECORD;
    ws_enabled BOOLEAN;
    user_override BOOLEAN;
    final_enabled BOOLEAN;
BEGIN
    -- A signed-in client may only ask about itself (super admins may ask about anyone).
    IF v_caller IS NOT NULL AND v_caller <> p_user_id AND NOT public.is_super_admin(v_caller) THEN
        RAISE EXCEPTION 'Not allowed to read module permissions of another user' USING ERRCODE = '42501';
    END IF;

    SELECT public.is_super_admin(p_user_id) INTO is_super;

    IF is_super THEN
        FOR mod IN SELECT module_key FROM public.platform_modules WHERE is_active = true LOOP
            result := jsonb_set(result, ARRAY[mod.module_key], 'true'::jsonb);
        END LOOP;
        RETURN result;
    END IF;

    FOR mod IN SELECT module_key FROM public.platform_modules WHERE is_active = true LOOP
        ws_enabled := NULL;
        user_override := NULL;

        SELECT enabled INTO ws_enabled
        FROM public.workspace_module_permissions
        WHERE workspace_id = p_workspace_id AND module_key = mod.module_key;

        IF ws_enabled IS NULL THEN
            ws_enabled := true;
        END IF;

        SELECT enabled INTO user_override
        FROM public.user_module_permissions
        WHERE user_id = p_user_id AND workspace_id = p_workspace_id AND module_key = mod.module_key;

        IF user_override IS NOT NULL THEN
            final_enabled := user_override;
        ELSE
            final_enabled := ws_enabled;
        END IF;

        result := jsonb_set(result, ARRAY[mod.module_key], to_jsonb(final_enabled));
    END LOOP;

    RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.is_super_admin(UUID)                   FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_user_effective_modules(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_super_admin(UUID)                   TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_user_effective_modules(UUID, UUID) TO authenticated, service_role;
