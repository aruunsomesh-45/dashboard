# 125East Per-User Module Permission System

## 1. Supported Modules

The system provides fine-grained, independent access control across seven core functional modules:

| Key | Module Name | Scope & Capabilities |
|---|---|---|
| `shopify` | Shopify Store Analytics | Orders, products, customers, and gross/net revenue |
| `razorpay` | Razorpay Payments | Gateway charges, authorization rates, refunds, and fees |
| `delivery` | Logistics & Delivery | Shipments, AWBs, NDR handling, RTO metrics, and tracking |
| `meta_ads` | Meta Ads Intelligence | Campaigns, ad spend, impressions, clicks, and ROAS |
| `instagram` | Organic Instagram | Social reach, media engagement, followers, and creator reels |
| `inventory` | Inventory Management | Stock tracking, multi-location SKUs, and replenishment alerts |
| `influencer` | Influencer Dashboard | Creator affiliate ROI, coupon redemption, and campaign tracking |

---

## 2. Permission Precedence & Resolution Hierarchy

Permission calculation resolves deterministically following a 4-tier evaluation chain:

```mermaid
flowchart TD
    START([User Attempts Access to Module M]) --> CHECK_GLOBAL{Is Module M Active Globally in platform_modules?}
    CHECK_GLOBAL -- "NO (Killed)" --> DENY[DENY ACCESS (HTTP 403)]
    CHECK_GLOBAL -- "YES" --> CHECK_SUPER{Is Caller a Platform Super Admin?}
    CHECK_SUPER -- "YES" --> ALLOW[ALLOW ACCESS]
    CHECK_SUPER -- "NO" --> CHECK_OVERRIDE{Does User Have Override in user_module_permissions?}
    CHECK_OVERRIDE -- "Override = false" --> DENY
    CHECK_OVERRIDE -- "Override = true" --> ALLOW
    CHECK_OVERRIDE -- "No Override (Inherit)" --> CHECK_WS{Is Module Enabled in workspace_module_permissions?}
    CHECK_WS -- "NO" --> DENY
    CHECK_WS -- "YES / Default" --> ALLOW
```

### Precedence Rules:
1. **Tier 1 — Global Kill Switch (`platform_modules.is_active`):**
   If a module is marked inactive at the platform level, no tenant or user can access it, regardless of overrides.
2. **Tier 2 — Super Admin Universal Bypass (`accounts_user.is_superuser`):**
   Super Administrators maintain universal access across all active modules for administration, debugging, and cross-tenant auditing.
3. **Tier 3 — Per-User Override (`user_module_permissions.enabled`):**
   - `enabled = true`: Explicitly unlocks the module for this user, even if their workspace baseline restricts it.
   - `enabled = false`: Explicitly locks the module for this user, even if their workspace baseline permits it.
   - `NULL / No record`: Falls back to the workspace baseline.
4. **Tier 4 — Workspace Baseline (`workspace_module_permissions.enabled`):**
   Establishes the default allowed baseline for all standard members of a workspace. If not explicitly disabled, defaults to `true`.

---

## 3. Database Schema

### `platform_modules`
```sql
CREATE TABLE IF NOT EXISTS public.platform_modules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  module_key text UNIQUE NOT NULL,
  module_name text NOT NULL,
  description text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

### `workspace_module_permissions`
```sql
CREATE TABLE IF NOT EXISTS public.workspace_module_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.tenancy_workspace(id) ON DELETE CASCADE,
  module_key text NOT NULL REFERENCES public.platform_modules(module_key) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  updated_by uuid REFERENCES public.accounts_user(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, module_key)
);
```

### `user_module_permissions`
```sql
CREATE TABLE IF NOT EXISTS public.user_module_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.accounts_user(id) ON DELETE CASCADE,
  module_key text NOT NULL REFERENCES public.platform_modules(module_key) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  updated_by uuid REFERENCES public.accounts_user(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, module_key)
);
```

### `admin_audit_logs`
```sql
CREATE TABLE IF NOT EXISTS public.admin_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id uuid REFERENCES public.accounts_user(id) ON DELETE SET NULL,
  action text NOT NULL,
  target_user_id uuid REFERENCES public.accounts_user(id) ON DELETE SET NULL,
  target_workspace_id uuid REFERENCES public.tenancy_workspace(id) ON DELETE SET NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

---

## 4. Stored Procedure for Resolution

```sql
CREATE OR REPLACE FUNCTION public.get_user_effective_modules(
  p_user_id uuid,
  p_workspace_id uuid
)
RETURNS TABLE (
  module_key text,
  module_name text,
  enabled boolean,
  is_global_active boolean,
  workspace_baseline boolean,
  user_override boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT
    pm.module_key,
    pm.module_name,
    CASE
      WHEN NOT pm.is_active THEN false
      WHEN u.is_superuser THEN true
      WHEN ump.enabled IS NOT NULL THEN ump.enabled
      WHEN wmp.enabled IS NOT NULL THEN wmp.enabled
      ELSE true
    END AS enabled,
    pm.is_active AS is_global_active,
    COALESCE(wmp.enabled, true) AS workspace_baseline,
    ump.enabled AS user_override
  FROM public.platform_modules pm
  LEFT JOIN public.accounts_user u ON u.id = p_user_id
  LEFT JOIN public.workspace_module_permissions wmp
    ON wmp.module_key = pm.module_key AND wmp.workspace_id = p_workspace_id
  LEFT JOIN public.user_module_permissions ump
    ON ump.module_key = pm.module_key AND ump.user_id = p_user_id
  ORDER BY pm.created_at ASC;
END;
$$;
```
