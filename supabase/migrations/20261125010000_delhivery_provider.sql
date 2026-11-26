-- Allow the Delhivery integration (integrations_integration.provider). 'shiprocket' is kept so existing rows
-- can never violate the re-added constraint; no code writes it any more.
ALTER TABLE public.integrations_integration DROP CONSTRAINT IF EXISTS chk_integrations_provider;
ALTER TABLE public.integrations_integration
    ADD CONSTRAINT chk_integrations_provider
    CHECK (provider IN ('shopify', 'razorpay', 'delhivery', 'shiprocket', 'meta_ads', 'instagram'));
