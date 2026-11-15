-- ============================================================================
-- Migration: 20261110000002_accounts_and_tenancy.sql
-- Description: Identity, Custom Accounts, Multi-tenancy Core, RBAC, and Audit Logs
-- ============================================================================

-- 1. Accounts & Identity
CREATE TABLE IF NOT EXISTS public.accounts_user (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(254) NOT NULL,
    password VARCHAR(128) NOT NULL,
    first_name VARCHAR(150) NOT NULL DEFAULT '',
    last_name VARCHAR(150) NOT NULL DEFAULT '',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    is_staff BOOLEAN NOT NULL DEFAULT FALSE,
    is_superuser BOOLEAN NOT NULL DEFAULT FALSE,
    mfa_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    mfa_secret VARCHAR(64) NOT NULL DEFAULT '',
    last_login TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_accounts_user_email UNIQUE (email),
    CONSTRAINT chk_accounts_user_email_format CHECK (email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$')
);

CREATE TRIGGER trg_accounts_user_updated_at
BEFORE UPDATE ON public.accounts_user
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.accounts_mfarecoverycode (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.accounts_user(id) ON DELETE CASCADE,
    code_hash VARCHAR(128) NOT NULL,
    used_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_accounts_recovery_user_hash UNIQUE (user_id, code_hash)
);

-- 2. Multi-tenancy Core
CREATE TABLE IF NOT EXISTS public.tenancy_workspace (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(50) NOT NULL,
    plan VARCHAR(30) NOT NULL DEFAULT 'starter',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_tenancy_workspace_slug UNIQUE (slug),
    CONSTRAINT chk_tenancy_workspace_plan CHECK (plan IN ('starter', 'growth', 'enterprise'))
);

CREATE TRIGGER trg_tenancy_workspace_updated_at
BEFORE UPDATE ON public.tenancy_workspace
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.tenancy_workspacemember (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES public.tenancy_workspace(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES public.accounts_user(id) ON DELETE CASCADE,
    role VARCHAR(20) NOT NULL DEFAULT 'viewer',
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_tenancy_workspacemember UNIQUE (workspace_id, user_id),
    CONSTRAINT chk_tenancy_member_role CHECK (role IN ('owner', 'admin', 'analyst', 'viewer'))
);

CREATE TABLE IF NOT EXISTS public.tenancy_brand (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES public.tenancy_workspace(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    timezone VARCHAR(50) NOT NULL DEFAULT 'Asia/Kolkata',
    currency VARCHAR(3) NOT NULL DEFAULT 'INR',
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_tenancy_brand_workspace_name UNIQUE (workspace_id, name)
);

CREATE TRIGGER trg_tenancy_brand_updated_at
BEFORE UPDATE ON public.tenancy_brand
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.tenancy_brandmember (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    brand_id UUID NOT NULL REFERENCES public.tenancy_brand(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES public.accounts_user(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_tenancy_brandmember UNIQUE (brand_id, user_id)
);

CREATE TABLE IF NOT EXISTS public.tenancy_invite (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES public.tenancy_workspace(id) ON DELETE CASCADE,
    email VARCHAR(254) NOT NULL,
    role VARCHAR(20) NOT NULL DEFAULT 'viewer',
    token_hash VARCHAR(128) NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_by_id UUID NULL REFERENCES public.accounts_user(id) ON DELETE SET NULL,
    accepted_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_tenancy_invite_token_hash UNIQUE (token_hash),
    CONSTRAINT chk_tenancy_invite_role CHECK (role IN ('owner', 'admin', 'analyst', 'viewer'))
);

CREATE TABLE IF NOT EXISTS public.tenancy_auditlog (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES public.tenancy_workspace(id) ON DELETE CASCADE,
    actor_id UUID NULL REFERENCES public.accounts_user(id) ON DELETE SET NULL,
    action VARCHAR(100) NOT NULL,
    target VARCHAR(255) NOT NULL DEFAULT '',
    ip_address INET NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
