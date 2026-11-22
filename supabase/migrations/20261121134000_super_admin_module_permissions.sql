-- 125East Super Admin & Per-User Module Permission System Migration

CREATE TABLE IF NOT EXISTS public.platform_modules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    module_key VARCHAR(50) UNIQUE NOT NULL,
    module_name VARCHAR(100) NOT NULL,
    description TEXT,
    category VARCHAR(50) DEFAULT 'core',
    icon VARCHAR(50),
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.workspace_module_permissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES public.tenancy_workspace(id) ON DELETE CASCADE,
    module_key VARCHAR(50) NOT NULL REFERENCES public.platform_modules(module_key) ON DELETE CASCADE,
    enabled BOOLEAN NOT NULL DEFAULT true,
    updated_by UUID,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_workspace_module UNIQUE(workspace_id, module_key)
);

CREATE TABLE IF NOT EXISTS public.user_module_permissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.accounts_user(id) ON DELETE CASCADE,
    workspace_id UUID NOT NULL REFERENCES public.tenancy_workspace(id) ON DELETE CASCADE,
    module_key VARCHAR(50) NOT NULL REFERENCES public.platform_modules(module_key) ON DELETE CASCADE,
    enabled BOOLEAN NOT NULL DEFAULT true,
    updated_by UUID,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_user_workspace_module UNIQUE(user_id, workspace_id, module_key)
);

CREATE TABLE IF NOT EXISTS public.admin_audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_user_id UUID NOT NULL,
    action VARCHAR(100) NOT NULL,
    target_user_id UUID,
    target_workspace_id UUID,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    ip_address VARCHAR(45),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed the 7 Platform Modules
INSERT INTO public.platform_modules (module_key, module_name, description, category, icon, is_active)
VALUES
    ('shopify', 'Shopify Store', 'Shopify store catalog, customer sync, and real-time order ingestion', 'commerce', 'ShoppingBag', true),
    ('razorpay', 'Razorpay Payments', 'Payment gateway transactions, capture reconciliation, and refund tracking', 'payments', 'CreditCard', true),
    ('delivery', 'Logistics & Delivery', 'Courier partner tracking, shipping status, and fulfillment metrics', 'logistics', 'Truck', true),
    ('meta_ads', 'Meta Ads', 'Facebook and Instagram paid campaigns, ROAS, and ad spend analytics', 'marketing', 'Megaphone', true),
    ('instagram', 'Organic Instagram', 'Social engagement metrics, post reach, follower velocity, and content stats', 'marketing', 'Camera', true),
    ('inventory', 'Inventory Management', 'SKU stock levels, warehouse inventory tracking, and replenishment alerts', 'operations', 'Boxes', true),
    ('influencer', 'Influencer Dashboard', 'Affiliate creators, discount code tracking, and campaign ROI analytics', 'marketing', 'Award', true)
ON CONFLICT (module_key) DO UPDATE SET
    module_name = EXCLUDED.module_name,
    description = EXCLUDED.description,
    category = EXCLUDED.category,
    icon = EXCLUDED.icon,
    is_active = EXCLUDED.is_active;

-- Helper function to check if a user is Super Admin
CREATE OR REPLACE FUNCTION public.is_super_admin(check_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.accounts_user
        WHERE id = check_user_id AND is_superuser = true AND is_active = true
    );
$$;

-- Function to calculate effective module permissions for a user
CREATE OR REPLACE FUNCTION public.get_user_effective_modules(p_user_id UUID, p_workspace_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    is_super BOOLEAN;
    result JSONB := '{}'::jsonb;
    mod RECORD;
    ws_enabled BOOLEAN;
    user_override BOOLEAN;
    final_enabled BOOLEAN;
BEGIN
    SELECT is_super_admin(p_user_id) INTO is_super;
    
    -- Super Admin has access to every active module
    IF is_super THEN
        FOR mod IN SELECT module_key FROM public.platform_modules WHERE is_active = true LOOP
            result := jsonb_set(result, ARRAY[mod.module_key], 'true'::jsonb);
        END LOOP;
        RETURN result;
    END IF;

    -- For normal user: evaluate per active module
    FOR mod IN SELECT module_key FROM public.platform_modules WHERE is_active = true LOOP
        -- Check workspace baseline (default to true if no row exists)
        SELECT enabled INTO ws_enabled
        FROM public.workspace_module_permissions
        WHERE workspace_id = p_workspace_id AND module_key = mod.module_key;
        
        IF ws_enabled IS NULL THEN
            ws_enabled := true;
        END IF;

        -- Check per-user override
        SELECT enabled INTO user_override
        FROM public.user_module_permissions
        WHERE user_id = p_user_id AND workspace_id = p_workspace_id AND module_key = mod.module_key;

        -- User override takes precedence over workspace baseline
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
