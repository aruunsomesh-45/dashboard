-- ============================================================================
-- Migration: 20261121150100_reassert_client_column_privileges.sql
-- Severity:  P0 (privilege escalation / 2FA bypass on the hosted database)
--
-- QA audit 2026-11-21 found the hosted project's _schema_migrations stops at 20261112000013:
-- 20261110000011_security_hardening.sql (column-level protection) was never applied there.
-- Live state observed via read-only catalog queries:
--   * authenticated holds table-level SELECT/INSERT/UPDATE/DELETE on public.accounts_user, and the
--     rls_user_self_update policy lets a user update their OWN row. Through PostgREST a signed-in Supabase
--     user can therefore set is_superuser = true (super-admin console trusts that column), set
--     mfa_enabled = false (Django then skips the TOTP step), and read password / mfa_secret.
--   * authenticated holds ALL on public.accounts_mfarecoverycode (+ self RLS policy): a user can INSERT a
--     recovery-code hash they know and use it to pass the Django 2FA challenge.
--   * authenticated holds SELECT on public.integrations_integration.encrypted_credentials (ciphertext).
--
-- This migration is idempotent and re-asserts the intended least-privilege state regardless of what was
-- applied before. A BEFORE UPDATE trigger additionally blocks client roles from changing privileged
-- accounts_user columns even if a broad GRANT is ever re-applied. Server roles (postgres, service_role,
-- app_user for Django, SECURITY DEFINER auth triggers) are unaffected. No data is modified.
-- ============================================================================

-- Anonymous clients never need direct table access (sign-up goes through GoTrue; RPCs keep their own grants).
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;

-- ---------------------------------------------------------------------------
-- accounts_user: read own non-secret columns, edit own name only
-- ---------------------------------------------------------------------------
REVOKE ALL ON public.accounts_user FROM anon, authenticated;
DO $$
DECLARE cols TEXT;
BEGIN
    SELECT string_agg(quote_ident(column_name), ',' ORDER BY ordinal_position) INTO cols
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'accounts_user'
      AND column_name NOT IN ('password', 'mfa_secret');
    EXECUTE format('GRANT SELECT (%s) ON public.accounts_user TO authenticated', cols);
END $$;
GRANT UPDATE (first_name, last_name) ON public.accounts_user TO authenticated;

CREATE OR REPLACE FUNCTION public.guard_accounts_user_privileged_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
    -- current_user is the invoking role: 'authenticated'/'anon' for PostgREST clients.
    IF current_user IN ('anon', 'authenticated') AND (
           NEW.id           IS DISTINCT FROM OLD.id
        OR NEW.email        IS DISTINCT FROM OLD.email
        OR NEW.password     IS DISTINCT FROM OLD.password
        OR NEW.is_active    IS DISTINCT FROM OLD.is_active
        OR NEW.is_staff     IS DISTINCT FROM OLD.is_staff
        OR NEW.is_superuser IS DISTINCT FROM OLD.is_superuser
        OR NEW.mfa_enabled  IS DISTINCT FROM OLD.mfa_enabled
        OR NEW.mfa_secret   IS DISTINCT FROM OLD.mfa_secret
    ) THEN
        RAISE EXCEPTION 'Privileged accounts_user columns can only be changed by the server'
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_accounts_user_guard_privileged ON public.accounts_user;
CREATE TRIGGER trg_accounts_user_guard_privileged
    BEFORE UPDATE ON public.accounts_user
    FOR EACH ROW EXECUTE FUNCTION public.guard_accounts_user_privileged_columns();

-- ---------------------------------------------------------------------------
-- MFA recovery codes are managed only by the Django backend (app_user).
-- ---------------------------------------------------------------------------
REVOKE ALL ON public.accounts_mfarecoverycode FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- Integration credentials never leave the database for client roles.
-- ---------------------------------------------------------------------------
REVOKE SELECT ON public.integrations_integration FROM anon, authenticated;
DO $$
DECLARE cols TEXT;
BEGIN
    SELECT string_agg(quote_ident(column_name), ',' ORDER BY ordinal_position) INTO cols
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'integrations_integration'
      AND column_name <> 'encrypted_credentials';
    EXECUTE format('GRANT SELECT (%s) ON public.integrations_integration TO authenticated', cols);
END $$;
