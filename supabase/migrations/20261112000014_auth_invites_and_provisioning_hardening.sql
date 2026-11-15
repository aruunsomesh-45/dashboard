-- ============================================================================
-- Migration: 20261112000014_auth_invites_and_provisioning_hardening.sql
-- Description: Phase 4 authentication hardening
--   1. Harden handle_new_auth_user (length-safe slug/name, no client-controlled
--      privilege, invite acceptance only against verified-email semantics)
--   2. Accept pending invites for EXISTING users when they sign in
--      (the INSERT trigger only ever covered brand-new users)
--   3. Server-side invite RPCs bound to the caller's verified email
--   4. Block invite role escalation (admins cannot mint owners)
--   5. Never allow a workspace to lose its last owner
--   6. Members listing RPC (accounts_user RLS is self-only by design)
-- ============================================================================

-- 1. Provisioning trigger ----------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS TRIGGER AS $$
DECLARE
    v_first_name   VARCHAR(150);
    v_last_name    VARCHAR(150);
    v_email        TEXT;
    v_org_name     VARCHAR(255);
    v_base_slug    TEXT;
    v_slug         TEXT;
    v_workspace_id UUID;
    v_invite       RECORD;
    v_accepted     BOOLEAN := FALSE;
    v_counter      INT := 0;
BEGIN
    v_email := LOWER(TRIM(NEW.email));
    IF v_email IS NULL OR v_email = '' THEN
        -- Phone / anonymous users are not supported by this product.
        RETURN NEW;
    END IF;

    -- Names come from OAuth metadata. Treated as display data only.
    v_first_name := LEFT(COALESCE(
        NULLIF(NEW.raw_user_meta_data->>'first_name', ''),
        NULLIF(split_part(COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'name', ''), ' ', 1), ''),
        ''
    ), 150);
    v_last_name := LEFT(COALESCE(
        NULLIF(NEW.raw_user_meta_data->>'last_name', ''),
        NULLIF(TRIM(SUBSTRING(COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'name', '') FROM POSITION(' ' IN COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'name', '') || ' '))), ''),
        ''
    ), 150);

    INSERT INTO public.accounts_user (id, email, password, first_name, last_name, is_active, is_staff, is_superuser, created_at, updated_at)
    VALUES (NEW.id, v_email, 'supabase_auth_managed', v_first_name, v_last_name, TRUE, FALSE, FALSE, clock_timestamp(), clock_timestamp())
    ON CONFLICT (id) DO UPDATE SET
        email      = EXCLUDED.email,
        first_name = CASE WHEN public.accounts_user.first_name = '' THEN EXCLUDED.first_name ELSE public.accounts_user.first_name END,
        last_name  = CASE WHEN public.accounts_user.last_name  = '' THEN EXCLUDED.last_name  ELSE public.accounts_user.last_name  END,
        updated_at = clock_timestamp();

    -- Pending, unexpired invites for this email. Sign-in requires proof of email
    -- ownership (OTP or Google-verified), so membership is only ever usable by the
    -- real mailbox owner.
    FOR v_invite IN
        SELECT * FROM public.tenancy_invite
        WHERE LOWER(email) = v_email AND accepted_at IS NULL AND expires_at > clock_timestamp()
        ORDER BY created_at ASC
    LOOP
        INSERT INTO public.tenancy_workspacemember (workspace_id, user_id, role)
        VALUES (v_invite.workspace_id, NEW.id, v_invite.role)
        ON CONFLICT (workspace_id, user_id) DO NOTHING;

        UPDATE public.tenancy_invite SET accepted_at = clock_timestamp() WHERE id = v_invite.id;

        INSERT INTO public.tenancy_auditlog (workspace_id, actor_id, action, target, metadata)
        VALUES (v_invite.workspace_id, NEW.id, 'invite_accepted', v_invite.id::text,
                jsonb_build_object('email', v_email, 'role', v_invite.role, 'via', 'signup'));
        v_accepted := TRUE;
    END LOOP;

    -- Invited users join the inviting organization only; everyone else gets their own.
    IF NOT v_accepted AND NOT EXISTS (SELECT 1 FROM public.tenancy_workspacemember WHERE user_id = NEW.id) THEN
        -- organization_name in user metadata is client-supplied: keep it as a label only.
        v_org_name := LEFT(COALESCE(
            NULLIF(TRIM(NEW.raw_user_meta_data->>'organization_name'), ''),
            INITCAP(split_part(v_email, '@', 1)) || ' Store'
        ), 120);

        v_base_slug := TRIM(BOTH '-' FROM LOWER(REGEXP_REPLACE(v_org_name, '[^a-zA-Z0-9]+', '-', 'g')));
        IF v_base_slug = '' THEN
            v_base_slug := 'org-' || SUBSTRING(NEW.id::text, 1, 8);
        END IF;
        v_base_slug := LEFT(v_base_slug, 40);   -- slug column is VARCHAR(50); leave room for suffix
        v_slug := v_base_slug;
        WHILE EXISTS (SELECT 1 FROM public.tenancy_workspace WHERE slug = v_slug) LOOP
            v_counter := v_counter + 1;
            v_slug := v_base_slug || '-' || v_counter;
        END LOOP;

        v_workspace_id := gen_random_uuid();
        INSERT INTO public.tenancy_workspace (id, name, slug, plan, is_active)
        VALUES (v_workspace_id, v_org_name, v_slug, 'starter', TRUE);

        INSERT INTO public.tenancy_workspacemember (workspace_id, user_id, role)
        VALUES (v_workspace_id, NEW.id, 'owner');

        INSERT INTO public.tenancy_brand (workspace_id, name, timezone, currency)
        VALUES (v_workspace_id, v_org_name, 'Asia/Kolkata', 'INR');

        INSERT INTO public.billing_subscription (workspace_id, plan, status, max_brands, max_members, history_days_limit, current_period_end)
        VALUES (v_workspace_id, 'starter', 'active', 1, 3, 30, clock_timestamp() + INTERVAL '30 days');

        INSERT INTO public.tenancy_auditlog (workspace_id, actor_id, action, target, metadata)
        VALUES (v_workspace_id, NEW.id, 'organization_created', v_workspace_id::text,
                jsonb_build_object('name', v_org_name, 'slug', v_slug));
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.handle_new_auth_user() FROM PUBLIC, anon, authenticated;

-- 2. Accept invites for existing users on sign-in ----------------------------
-- Fires when GoTrue stamps a successful sign-in. Only confirmed emails qualify.
CREATE OR REPLACE FUNCTION public.handle_auth_user_signin()
RETURNS TRIGGER AS $$
DECLARE
    v_email  TEXT := LOWER(TRIM(NEW.email));
    v_invite RECORD;
BEGIN
    IF v_email IS NULL OR v_email = '' OR NEW.email_confirmed_at IS NULL THEN
        RETURN NEW;
    END IF;
    -- accounts_user row must exist (created by the INSERT trigger)
    IF NOT EXISTS (SELECT 1 FROM public.accounts_user WHERE id = NEW.id) THEN
        RETURN NEW;
    END IF;

    FOR v_invite IN
        SELECT * FROM public.tenancy_invite
        WHERE LOWER(email) = v_email AND accepted_at IS NULL AND expires_at > clock_timestamp()
        ORDER BY created_at ASC
    LOOP
        INSERT INTO public.tenancy_workspacemember (workspace_id, user_id, role)
        VALUES (v_invite.workspace_id, NEW.id, v_invite.role)
        ON CONFLICT (workspace_id, user_id) DO NOTHING;   -- never downgrade/upgrade silently

        UPDATE public.tenancy_invite SET accepted_at = clock_timestamp() WHERE id = v_invite.id;

        INSERT INTO public.tenancy_auditlog (workspace_id, actor_id, action, target, metadata)
        VALUES (v_invite.workspace_id, NEW.id, 'invite_accepted', v_invite.id::text,
                jsonb_build_object('email', v_email, 'role', v_invite.role, 'via', 'signin'));
    END LOOP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.handle_auth_user_signin() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS on_auth_user_signin ON auth.users;
CREATE TRIGGER on_auth_user_signin
AFTER UPDATE OF last_sign_in_at ON auth.users
FOR EACH ROW
WHEN (NEW.last_sign_in_at IS DISTINCT FROM OLD.last_sign_in_at)
EXECUTE FUNCTION public.handle_auth_user_signin();

-- 3. Invite escalation guard on the table itself -----------------------------
-- Admins may invite admin/analyst/viewer; only owners may mint owners.
DROP POLICY IF EXISTS rls_invite_insert ON public.tenancy_invite;
CREATE POLICY rls_invite_insert ON public.tenancy_invite
FOR INSERT TO authenticated, app_user
WITH CHECK (
    public.has_workspace_role(workspace_id, ARRAY['owner', 'admin'])
    AND (role <> 'owner' OR public.has_workspace_role(workspace_id, ARRAY['owner']))
);

DROP POLICY IF EXISTS rls_invite_update ON public.tenancy_invite;
CREATE POLICY rls_invite_update ON public.tenancy_invite
FOR UPDATE TO authenticated, app_user
USING (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin']))
WITH CHECK (
    public.has_workspace_role(workspace_id, ARRAY['owner', 'admin'])
    AND (role <> 'owner' OR public.has_workspace_role(workspace_id, ARRAY['owner']))
);

-- token_hash must never be readable by browsers: revoke column access.
REVOKE SELECT (token_hash) ON public.tenancy_invite FROM authenticated, anon;

-- 4. Invite RPCs --------------------------------------------------------------
-- create_invite: returns the raw token ONCE; only its SHA-256 is stored.
CREATE OR REPLACE FUNCTION public.create_invite(p_workspace_id UUID, p_email TEXT, p_role TEXT)
RETURNS JSONB AS $$
DECLARE
    v_uid   UUID := (SELECT auth.uid());
    v_email TEXT := LOWER(TRIM(p_email));
    v_token TEXT;
    v_id    UUID;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
    END IF;
    IF v_email !~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$' THEN
        RAISE EXCEPTION 'invalid_email' USING ERRCODE = '22023';
    END IF;
    IF p_role NOT IN ('owner', 'admin', 'analyst', 'viewer') THEN
        RAISE EXCEPTION 'invalid_role' USING ERRCODE = '22023';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.tenancy_workspacemember
                   WHERE workspace_id = p_workspace_id AND user_id = v_uid AND role IN ('owner', 'admin')) THEN
        RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
    END IF;
    IF p_role = 'owner' AND NOT EXISTS (SELECT 1 FROM public.tenancy_workspacemember
                   WHERE workspace_id = p_workspace_id AND user_id = v_uid AND role = 'owner') THEN
        RAISE EXCEPTION 'forbidden_role' USING ERRCODE = '42501';
    END IF;
    IF EXISTS (SELECT 1 FROM public.tenancy_workspacemember m JOIN public.accounts_user u ON u.id = m.user_id
               WHERE m.workspace_id = p_workspace_id AND LOWER(u.email) = v_email) THEN
        RAISE EXCEPTION 'already_member' USING ERRCODE = '23505';
    END IF;

    -- Supersede earlier unaccepted invites for the same address.
    DELETE FROM public.tenancy_invite
    WHERE workspace_id = p_workspace_id AND LOWER(email) = v_email AND accepted_at IS NULL;

    v_token := translate(encode(gen_random_bytes(32), 'base64'), '+/=', '-_');
    INSERT INTO public.tenancy_invite (workspace_id, email, role, token_hash, expires_at, created_by_id)
    VALUES (p_workspace_id, v_email, p_role, encode(digest(v_token, 'sha256'), 'hex'),
            clock_timestamp() + INTERVAL '72 hours', v_uid)
    RETURNING id INTO v_id;

    INSERT INTO public.tenancy_auditlog (workspace_id, actor_id, action, target, metadata)
    VALUES (p_workspace_id, v_uid, 'invite_created', v_email, jsonb_build_object('role', p_role));

    RETURN jsonb_build_object('id', v_id, 'token', v_token, 'expires_in_hours', 72);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp;

-- accept_invite: caller's verified JWT email must equal the invited address.
CREATE OR REPLACE FUNCTION public.accept_invite(p_token TEXT)
RETURNS JSONB AS $$
DECLARE
    v_uid    UUID := (SELECT auth.uid());
    v_email  TEXT := LOWER(COALESCE((SELECT auth.jwt()) ->> 'email', ''));
    v_invite RECORD;
BEGIN
    IF v_uid IS NULL OR v_email = '' THEN
        RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
    END IF;

    SELECT * INTO v_invite FROM public.tenancy_invite
    WHERE token_hash = encode(digest(COALESCE(p_token, ''), 'sha256'), 'hex')
    FOR UPDATE;

    -- One generic failure for unknown / used / expired / wrong-mailbox: no oracle.
    IF v_invite.id IS NULL OR v_invite.accepted_at IS NOT NULL
       OR v_invite.expires_at <= clock_timestamp() OR LOWER(v_invite.email) <> v_email THEN
        RAISE EXCEPTION 'invalid_invite' USING ERRCODE = 'P0001';
    END IF;

    INSERT INTO public.tenancy_workspacemember (workspace_id, user_id, role)
    VALUES (v_invite.workspace_id, v_uid, v_invite.role)
    ON CONFLICT (workspace_id, user_id) DO NOTHING;

    UPDATE public.tenancy_invite SET accepted_at = clock_timestamp() WHERE id = v_invite.id;

    INSERT INTO public.tenancy_auditlog (workspace_id, actor_id, action, target, metadata)
    VALUES (v_invite.workspace_id, v_uid, 'invite_accepted', v_invite.id::text,
            jsonb_build_object('email', v_email, 'role', v_invite.role, 'via', 'token'));

    RETURN jsonb_build_object('workspace_id', v_invite.workspace_id, 'role', v_invite.role);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp;

-- list_workspace_members: caller must belong to the workspace.
CREATE OR REPLACE FUNCTION public.list_workspace_members(p_workspace_id UUID)
RETURNS TABLE (id UUID, user_id UUID, email TEXT, first_name TEXT, last_name TEXT,
               mfa_enabled BOOLEAN, role TEXT, created_at TIMESTAMPTZ) AS $$
BEGIN
    IF NOT public.is_member_of_workspace(p_workspace_id) THEN
        RETURN;
    END IF;
    RETURN QUERY
    SELECT m.id, m.user_id, u.email::TEXT, u.first_name::TEXT, u.last_name::TEXT,
           u.mfa_enabled, m.role::TEXT, m.created_at
    FROM public.tenancy_workspacemember m
    JOIN public.accounts_user u ON u.id = m.user_id
    WHERE m.workspace_id = p_workspace_id
    ORDER BY m.created_at;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.create_invite(UUID, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.accept_invite(TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.list_workspace_members(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_invite(UUID, TEXT, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.accept_invite(TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_workspace_members(UUID) TO authenticated, service_role;

-- 5. Last-owner protection ----------------------------------------------------
CREATE OR REPLACE FUNCTION public.protect_last_owner()
RETURNS TRIGGER AS $$
BEGIN
    -- Workspace deletion cascades; allow it.
    IF NOT EXISTS (SELECT 1 FROM public.tenancy_workspace WHERE id = OLD.workspace_id) THEN
        RETURN COALESCE(NEW, OLD);
    END IF;
    IF OLD.role = 'owner' AND (TG_OP = 'DELETE' OR NEW.role <> 'owner') THEN
        IF NOT EXISTS (SELECT 1 FROM public.tenancy_workspacemember
                       WHERE workspace_id = OLD.workspace_id AND role = 'owner' AND id <> OLD.id) THEN
            RAISE EXCEPTION 'last_owner' USING ERRCODE = 'P0001',
                  HINT = 'Transfer ownership before removing or demoting the last owner.';
        END IF;
    END IF;
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.protect_last_owner() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_protect_last_owner ON public.tenancy_workspacemember;
CREATE TRIGGER trg_protect_last_owner
BEFORE UPDATE OF role OR DELETE ON public.tenancy_workspacemember
FOR EACH ROW EXECUTE FUNCTION public.protect_last_owner();

