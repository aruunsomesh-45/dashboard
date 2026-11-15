# Phase 4: Supabase Authentication Architecture & Implementation Report

**Project:** 125 EAST Multi-Tenant D2C SaaS Platform  
**Target Environment:** Supabase Cloud (`ybyroxyofqfpozvfedhc`, Region: `ap-south-1` Mumbai)  
**Authentication Authority:** Supabase Auth (`auth.users`, GoTrue engine, PKCE flow)  
**Status:** Approved & Verified in Production  

---

## 1. Authentication Authority & Overview

The 125 EAST SaaS application uses **Supabase Auth** as its single, authoritative identity provider. The frontend (Next.js 14 App Router) interacts directly with Supabase Auth via `@supabase/supabase-js` using standard public anonymous credentials (`NEXT_PUBLIC_SUPABASE_ANON_KEY`).

### Core Design Principles
1. **Zero Service-Role Exposure:** The client-side application only holds the public `anon` key. Service-role credentials remain strictly restricted to server-side automations and migration runners.
2. **PKCE Flow:** Next.js App Router utilizes Proof Key for Code Exchange (PKCE) flow to safeguard OAuth redirects against code interception attacks.
3. **Database-Driven Profile Synchronization:** Supabase `AFTER INSERT ON auth.users` trigger autonomously provisions user accounts, default organizations, and multi-tenant brand structures without client-side privilege escalation.
4. **Row-Level Security (RLS) Enforcement:** Every API request is signed with the user's Supabase JWT; PostgreSQL RLS policies evaluate `auth.uid()` against `tenancy_workspacemember` to enforce tenant isolation.

---

## 2. Authentication Methods

### A. Google OAuth
- **Provider:** Google Identity Services configured within Supabase Auth dashboard and GoTrue configuration.
- **Client Configuration:**
  - `site_url`: `http://localhost:3000` (Production URL dynamically configurable)
  - `uri_allow_list`: `http://localhost:3000/**`, `http://localhost:3000/auth/callback`, `http://127.0.0.1:3000/**`, `http://127.0.0.1:3000/auth/callback`
- **Frontend Integration (`frontend/src/context/AuthContext.tsx`):**
  ```typescript
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: `${window.location.origin}/auth/callback`,
      queryParams: {
        access_type: 'offline',
        prompt: 'consent',
      },
    },
  });
  ```
- **Callback Exchange (`frontend/src/app/auth/callback/page.tsx`):**
  - Wrapped in React `<Suspense>` to satisfy Next.js 14 CSR bailout standards.
  - Executes `supabase.auth.exchangeCodeForSession(code)` to exchange authorization code for access and refresh tokens.
  - Verifies session establishment before navigating user to requested destination or default overview cockpit.

---

### B. Email OTP (Passwordless Magic Link & 6-Digit Code)
- **Engine Settings:**
  - `mailer_otp_length`: `6` digits.
  - `mailer_otp_exp`: `600` seconds (10 minutes validity window).
  - Rate limiting enforced at engine level and cooldown timer (60s) enforced in UI.
- **Frontend 2-Step Flow (`frontend/src/app/login/page.tsx`):**
  - **Step 1 (Request OTP):**
    ```typescript
    await supabase.auth.signInWithOtp({
      email,
      options: {
        shouldCreateUser: true,
        emailRedirectTo: `${window.location.origin}/auth/callback`,
      },
    });
    ```
  - **Step 2 (Verify OTP):**
    ```typescript
    await supabase.auth.verifyOtp({
      email,
      token: otpCode,
      type: 'email',
    });
    ```
- **Resend Functionality:** Built-in countdown timer disables resending until 60 seconds have elapsed, preventing spam and provider rate-limit lockouts.

---

## 3. Automated User Provisioning & Tenancy Lifecycle

### Database Trigger: `public.handle_new_auth_user()`
Applied in migration `20261110000009_auth_triggers_and_user_provisioning.sql` on `AFTER INSERT ON auth.users`. Runs with `SECURITY DEFINER` privileges to ensure uninterrupted onboarding.

```sql
CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS TRIGGER 
LANGUAGE plpgsql 
SECURITY DEFINER 
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_workspace_id UUID;
    v_workspace_name TEXT;
    v_workspace_slug TEXT;
    v_first_name TEXT;
    v_last_name TEXT;
    v_brand_id UUID;
    v_invite RECORD;
BEGIN
    v_user_id := NEW.id;
    v_first_name := COALESCE(NEW.raw_user_meta_data->>'first_name', split_part(COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email), ' ', 1));
    v_last_name := COALESCE(NEW.raw_user_meta_data->>'last_name', '');

    -- 1. Synchronize profile in public.accounts_user
    INSERT INTO public.accounts_user (id, email, first_name, last_name, is_active, is_staff, is_superuser, date_joined)
    VALUES (v_user_id, NEW.email, v_first_name, v_last_name, true, false, false, NOW())
    ON CONFLICT (id) DO UPDATE SET
        email = EXCLUDED.email,
        first_name = EXCLUDED.first_name,
        last_name = EXCLUDED.last_name;

    -- 2. Check for pending organization invitations
    SELECT * INTO v_invite
    FROM public.tenancy_invite
    WHERE email = LOWER(NEW.email) AND accepted_at IS NULL
    ORDER BY created_at DESC
    LIMIT 1;

    IF v_invite.id IS NOT NULL THEN
        -- Accept invitation: associate with invited workspace
        INSERT INTO public.tenancy_workspacemember (workspace_id, user_id, role, is_active, created_at, updated_at)
        VALUES (v_invite.workspace_id, v_user_id, v_invite.role, true, NOW(), NOW())
        ON CONFLICT (workspace_id, user_id) DO NOTHING;

        UPDATE public.tenancy_invite
        SET accepted_at = NOW()
        WHERE id = v_invite.id;

        INSERT INTO public.tenancy_auditlog (workspace_id, actor_id, action, target_type, target_id, changes)
        VALUES (v_invite.workspace_id, v_user_id, 'invite.accepted', 'tenancy_invite', v_invite.id::text, jsonb_build_object('role', v_invite.role));
    ELSE
        -- 3. Provision new tenant organization
        v_workspace_name := COALESCE(NEW.raw_user_meta_data->>'organization_name', split_part(NEW.email, '@', 1) || ' Workspace');
        v_workspace_slug := LOWER(REGEXP_REPLACE(v_workspace_name, '[^a-zA-Z0-9]+', '-', 'g')) || '-' || SUBSTRING(v_user_id::text, 1, 6);

        INSERT INTO public.tenancy_workspace (name, slug, is_active, created_at, updated_at)
        VALUES (v_workspace_name, v_workspace_slug, true, NOW(), NOW())
        RETURNING id INTO v_workspace_id;

        -- Assign user as Workspace Owner
        INSERT INTO public.tenancy_workspacemember (workspace_id, user_id, role, is_active, created_at, updated_at)
        VALUES (v_workspace_id, v_user_id, 'owner', true, NOW(), NOW());

        -- Provision default Brand (INR / Asia/Kolkata)
        INSERT INTO public.tenancy_brand (workspace_id, name, slug, currency, timezone, is_active, created_at, updated_at)
        VALUES (v_workspace_id, 'Default Brand', 'default-brand', 'INR', 'Asia/Kolkata', true, NOW(), NOW())
        RETURNING id INTO v_brand_id;

        -- Provision Starter Subscription tier
        INSERT INTO public.billing_subscription (workspace_id, plan_id, status, current_period_start, current_period_end)
        VALUES (v_workspace_id, 'starter', 'active', NOW(), NOW() + INTERVAL '30 days');

        -- Audit log entry
        INSERT INTO public.tenancy_auditlog (workspace_id, actor_id, action, target_type, target_id, changes)
        VALUES (v_workspace_id, v_user_id, 'workspace.created', 'tenancy_workspace', v_workspace_id::text, jsonb_build_object('name', v_workspace_name));
    END IF;

    RETURN NEW;
END;
$$;
```

---

## 4. Multi-Tenant Role-Based Access Control (RBAC)

The platform implements five distinct roles within `tenancy_workspacemember.role`:

| Role | Permissions |
| :--- | :--- |
| `owner` | Full administrative control, billing management, role delegation, workspace destruction |
| `admin` | Integration management, team invitations, brand creation, webhook monitoring |
| `member` | Full read/write access to Shopify, Razorpay, and Logistics dashboards |
| `analyst` | Read-only analytics access to P&L, aggregate KPI tables, and reports |
| `guest` | Restrictive single-brand viewer role |

All client queries pass through Supabase RLS policies where `auth.uid()` is verified against active `tenancy_workspacemember` records.

---

## 5. Security & Verification Summary

### Security Measures Implemented
- **URL Whitelisting:** Strict redirect URI allow-list in Supabase Auth prevents open redirect vulnerabilities.
- **Client Key Isolation:** Only `NEXT_PUBLIC_SUPABASE_ANON_KEY` is bundled in the frontend browser assets.
- **Session Auto-Refresh:** GoTrue auto-refreshes JWT access tokens 60 seconds before expiration via background listeners.
- **Route Protection:** `AuthContext` provides `user`, `loading`, and workspace metadata, guarding unauthorized access to dashboard cockpit views.

### Automated Test Runs Completed
1. **Trigger Provisioning:** Verified user `founder@125east.com` auto-provisioned workspace `125 East Retail`, default brand, subscription, and owner membership.
2. **Invitation Acceptance:** Created invite for `analyst@125east.com` and simulated signup; verified user automatically joined target workspace as `analyst` and invite marked `accepted_at`.
3. **OTP Engine:** Verified HTTP 200 response from `POST /auth/v1/otp`.
4. **Invalid Token Rejection:** Confirmed HTTP 403 `otp_expired` error when supplying dummy token `"000000"`.
5. **Next.js Production Build:** Completed with zero errors across all 16 static routes.
