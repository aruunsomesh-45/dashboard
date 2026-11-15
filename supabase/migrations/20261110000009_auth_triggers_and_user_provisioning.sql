-- ============================================================================
-- Migration: 20261110000009_auth_triggers_and_user_provisioning.sql
-- Description: Automatic user profile & workspace provisioning on auth.users sign-up
-- ============================================================================

-- Function triggered on new Supabase Auth user creation
CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS TRIGGER AS $$
DECLARE
    v_first_name VARCHAR(150);
    v_last_name VARCHAR(150);
    v_org_name VARCHAR(255);
    v_slug VARCHAR(50);
    v_base_slug VARCHAR(50);
    v_workspace_id UUID;
    v_brand_id UUID;
    v_invite_record RECORD;
    v_counter INT := 0;
BEGIN
    -- Extract name metadata from OAuth or metadata if provided
    v_first_name := COALESCE(NEW.raw_user_meta_data->>'first_name', NEW.raw_user_meta_data->>'full_name', '');
    v_last_name := COALESCE(NEW.raw_user_meta_data->>'last_name', '');
    
    -- Insert or update public.accounts_user
    INSERT INTO public.accounts_user (
        id,
        email,
        password,
        first_name,
        last_name,
        is_active,
        is_staff,
        is_superuser,
        created_at,
        updated_at
    ) VALUES (
        NEW.id,
        LOWER(TRIM(NEW.email)),
        'supabase_auth_managed',
        v_first_name,
        v_last_name,
        TRUE,
        FALSE,
        FALSE,
        clock_timestamp(),
        clock_timestamp()
    )
    ON CONFLICT (id) DO UPDATE SET
        email = EXCLUDED.email,
        first_name = CASE WHEN accounts_user.first_name = '' THEN EXCLUDED.first_name ELSE accounts_user.first_name END,
        last_name = CASE WHEN accounts_user.last_name = '' THEN EXCLUDED.last_name ELSE accounts_user.last_name END,
        updated_at = clock_timestamp();

    -- Check if user has an existing active invite
    SELECT * INTO v_invite_record
    FROM public.tenancy_invite
    WHERE email = LOWER(TRIM(NEW.email))
      AND expires_at > clock_timestamp()
      AND accepted_at IS NULL
    ORDER BY created_at DESC
    LIMIT 1;

    IF v_invite_record.id IS NOT NULL THEN
        -- Add user to invited workspace
        INSERT INTO public.tenancy_workspacemember (
            workspace_id,
            user_id,
            role,
            created_at
        ) VALUES (
            v_invite_record.workspace_id,
            NEW.id,
            v_invite_record.role,
            clock_timestamp()
        )
        ON CONFLICT (workspace_id, user_id) DO UPDATE SET
            role = EXCLUDED.role;

        -- Mark invite as accepted
        UPDATE public.tenancy_invite
        SET accepted_at = clock_timestamp()
        WHERE id = v_invite_record.id;

        -- Write audit log
        INSERT INTO public.tenancy_auditlog (
            workspace_id,
            actor_id,
            action,
            target,
            metadata
        ) VALUES (
            v_invite_record.workspace_id,
            NEW.id,
            'invite_accepted',
            v_invite_record.id::text,
            jsonb_build_object('email', NEW.email, 'role', v_invite_record.role)
        );
    ELSE
        -- No invite: provision a default Workspace and Brand for the new organization
        IF NOT EXISTS (SELECT 1 FROM public.tenancy_workspacemember WHERE user_id = NEW.id) THEN
            v_org_name := COALESCE(
                NULLIF(TRIM(NEW.raw_user_meta_data->>'organization_name'), ''),
                INITCAP(split_part(NEW.email, '@', 1)) || ' Store'
            );
            
            -- Generate slug
            v_base_slug := LOWER(REGEXP_REPLACE(v_org_name, '[^a-zA-Z0-9]+', '-', 'g'));
            v_base_slug := TRIM(BOTH '-' FROM v_base_slug);
            IF v_base_slug = '' THEN
                v_base_slug := 'org-' || SUBSTRING(NEW.id::text, 1, 8);
            END IF;
            
            v_slug := v_base_slug;
            WHILE EXISTS (SELECT 1 FROM public.tenancy_workspace WHERE slug = v_slug) LOOP
                v_counter := v_counter + 1;
                v_slug := v_base_slug || '-' || v_counter;
            END LOOP;

            v_workspace_id := gen_random_uuid();
            v_brand_id := gen_random_uuid();

            -- Create Workspace
            INSERT INTO public.tenancy_workspace (
                id,
                name,
                slug,
                plan,
                is_active
            ) VALUES (
                v_workspace_id,
                v_org_name,
                v_slug,
                'starter',
                TRUE
            );

            -- Assign user as Owner
            INSERT INTO public.tenancy_workspacemember (
                workspace_id,
                user_id,
                role
            ) VALUES (
                v_workspace_id,
                NEW.id,
                'owner'
            );

            -- Create Default Brand
            INSERT INTO public.tenancy_brand (
                id,
                workspace_id,
                name,
                timezone,
                currency
            ) VALUES (
                v_brand_id,
                v_workspace_id,
                v_org_name,
                'Asia/Kolkata',
                'INR'
            );

            -- Create Default Subscription
            INSERT INTO public.billing_subscription (
                workspace_id,
                plan,
                status,
                max_brands,
                max_members,
                history_days_limit,
                current_period_end
            ) VALUES (
                v_workspace_id,
                'starter',
                'active',
                1,
                3,
                30,
                clock_timestamp() + INTERVAL '30 days'
            );

            -- Write Audit Log
            INSERT INTO public.tenancy_auditlog (
                workspace_id,
                actor_id,
                action,
                target,
                metadata
            ) VALUES (
                v_workspace_id,
                NEW.id,
                'organization_created',
                v_workspace_id::text,
                jsonb_build_object('name', v_org_name, 'slug', v_slug)
            );
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Attach trigger to auth.users
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_auth_user();
