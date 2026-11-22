import sys
import os

sys.path.insert(0, 'backend')
os.environ['DJANGO_SETTINGS_MODULE'] = 'config.settings.dev'

import django
django.setup()

from django.db import connection

sql = """
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
    v_existing_id UUID;
    v_counter INT := 0;
BEGIN
    v_first_name := COALESCE(NEW.raw_user_meta_data->>'first_name', NEW.raw_user_meta_data->>'full_name', '');
    v_last_name := COALESCE(NEW.raw_user_meta_data->>'last_name', '');

    -- Check if an accounts_user already exists with this email (e.g. from Django)
    SELECT id INTO v_existing_id FROM public.accounts_user WHERE email = LOWER(TRIM(NEW.email));

    IF v_existing_id IS NOT NULL AND v_existing_id != NEW.id THEN
        -- Re-link existing memberships and logs to new Supabase Auth user ID
        UPDATE public.tenancy_workspacemember SET user_id = NEW.id WHERE user_id = v_existing_id;
        UPDATE public.tenancy_brandmember SET user_id = NEW.id WHERE user_id = v_existing_id;
        UPDATE public.tenancy_invite SET created_by_id = NEW.id WHERE created_by_id = v_existing_id;
        UPDATE public.tenancy_auditlog SET actor_id = NEW.id WHERE actor_id = v_existing_id;
        DELETE FROM public.accounts_mfarecoverycode WHERE user_id = v_existing_id;
        DELETE FROM public.accounts_user WHERE id = v_existing_id;
    END IF;

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

        UPDATE public.tenancy_invite
        SET accepted_at = clock_timestamp()
        WHERE id = v_invite_record.id;

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
        -- No invite: provision a default Workspace and Brand for the new organization if none exists
        IF NOT EXISTS (SELECT 1 FROM public.tenancy_workspacemember WHERE user_id = NEW.id) THEN
            v_org_name := COALESCE(
                NULLIF(TRIM(NEW.raw_user_meta_data->>'organization_name'), ''),
                INITCAP(split_part(NEW.email, '@', 1)) || ' Store'
            );

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

            INSERT INTO public.tenancy_workspacemember (
                workspace_id,
                user_id,
                role
            ) VALUES (
                v_workspace_id,
                NEW.id,
                'owner'
            );

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
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;
"""

with connection.cursor() as cursor:
    cursor.execute(sql)

print("SUCCESS: handle_new_auth_user function updated successfully!")
