-- ============================================================================
-- Migration: 20261110000004_integrations_and_webhooks.sql
-- Description: Third-party Connectors, OAuth Encrypted Storage & Partitioned Ingestion
-- ============================================================================

-- 1. Integration Connections & Encrypted Tokens
CREATE TABLE IF NOT EXISTS public.integrations_integration (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES public.tenancy_workspace(id) ON DELETE CASCADE,
    brand_id UUID NOT NULL REFERENCES public.tenancy_brand(id) ON DELETE CASCADE,
    provider VARCHAR(50) NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'disconnected',
    account_identifier VARCHAR(255) NOT NULL DEFAULT '',
    scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
    encrypted_credentials BYTEA NULL,
    token_expires_at TIMESTAMPTZ NULL,
    last_synced_at TIMESTAMPTZ NULL,
    last_error_message TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_integrations_integration UNIQUE (brand_id, provider),
    CONSTRAINT chk_integrations_provider CHECK (provider IN ('shopify', 'razorpay', 'shiprocket', 'meta_ads', 'instagram')),
    CONSTRAINT chk_integrations_status CHECK (status IN ('disconnected', 'connected', 'syncing', 'error', 'token_expiring'))
);

CREATE TRIGGER trg_integrations_integration_updated_at
BEFORE UPDATE ON public.integrations_integration
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 2. Sync Runs & Progress Cursors
CREATE TABLE IF NOT EXISTS public.integrations_syncrun (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES public.tenancy_workspace(id) ON DELETE CASCADE,
    brand_id UUID NOT NULL REFERENCES public.tenancy_brand(id) ON DELETE CASCADE,
    integration_id UUID NOT NULL REFERENCES public.integrations_integration(id) ON DELETE CASCADE,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    resource VARCHAR(50) NOT NULL,
    started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    finished_at TIMESTAMPTZ NULL,
    records_processed INTEGER NOT NULL DEFAULT 0 CHECK (records_processed >= 0),
    records_created INTEGER NOT NULL DEFAULT 0 CHECK (records_created >= 0),
    records_updated INTEGER NOT NULL DEFAULT 0 CHECK (records_updated >= 0),
    error_message TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT chk_integrations_syncrun_status CHECK (status IN ('pending', 'running', 'success', 'failed', 'partial'))
);

CREATE TRIGGER trg_integrations_syncrun_updated_at
BEFORE UPDATE ON public.integrations_syncrun
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.integrations_synccursor (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES public.tenancy_workspace(id) ON DELETE CASCADE,
    brand_id UUID NOT NULL REFERENCES public.tenancy_brand(id) ON DELETE CASCADE,
    integration_id UUID NOT NULL REFERENCES public.integrations_integration(id) ON DELETE CASCADE,
    resource VARCHAR(50) NOT NULL,
    cursor_value VARCHAR(255) NOT NULL,
    last_checkpoint TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_integrations_synccursor UNIQUE (integration_id, resource)
);

CREATE TRIGGER trg_integrations_synccursor_updated_at
BEFORE UPDATE ON public.integrations_synccursor
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 3. Partitioned High-Volume Raw Payloads
CREATE TABLE IF NOT EXISTS public.integrations_rawpayload (
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES public.tenancy_workspace(id) ON DELETE CASCADE,
    brand_id UUID NOT NULL REFERENCES public.tenancy_brand(id) ON DELETE CASCADE,
    provider VARCHAR(50) NOT NULL,
    topic VARCHAR(100) NOT NULL,
    entity_id VARCHAR(255) NOT NULL DEFAULT '',
    payload JSONB NOT NULL,
    replayed_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- Default and monthly partitions
CREATE TABLE IF NOT EXISTS public.rawpayload_default PARTITION OF public.integrations_rawpayload DEFAULT;
CREATE TABLE IF NOT EXISTS public.rawpayload_2026_10 PARTITION OF public.integrations_rawpayload
    FOR VALUES FROM ('2026-10-01 00:00:00+00') TO ('2026-11-01 00:00:00+00');
CREATE TABLE IF NOT EXISTS public.rawpayload_2026_11 PARTITION OF public.integrations_rawpayload
    FOR VALUES FROM ('2026-11-01 00:00:00+00') TO ('2026-12-01 00:00:00+00');
CREATE TABLE IF NOT EXISTS public.rawpayload_2026_12 PARTITION OF public.integrations_rawpayload
    FOR VALUES FROM ('2026-12-01 00:00:00+00') TO ('2027-01-01 00:00:00+00');

-- 4. Partitioned High-Volume Webhook Event Logs
CREATE TABLE IF NOT EXISTS public.integrations_webhookevent (
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES public.tenancy_workspace(id) ON DELETE CASCADE,
    brand_id UUID NOT NULL REFERENCES public.tenancy_brand(id) ON DELETE CASCADE,
    provider VARCHAR(50) NOT NULL,
    event_id VARCHAR(255) NOT NULL,
    topic VARCHAR(100) NOT NULL,
    raw_body TEXT NOT NULL,
    headers JSONB NOT NULL DEFAULT '{}'::jsonb,
    processed BOOLEAN NOT NULL DEFAULT FALSE,
    processed_at TIMESTAMPTZ NULL,
    error TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- Default and monthly partitions
CREATE TABLE IF NOT EXISTS public.webhookevent_default PARTITION OF public.integrations_webhookevent DEFAULT;
CREATE TABLE IF NOT EXISTS public.webhookevent_2026_10 PARTITION OF public.integrations_webhookevent
    FOR VALUES FROM ('2026-10-01 00:00:00+00') TO ('2026-11-01 00:00:00+00');
CREATE TABLE IF NOT EXISTS public.webhookevent_2026_11 PARTITION OF public.integrations_webhookevent
    FOR VALUES FROM ('2026-11-01 00:00:00+00') TO ('2026-12-01 00:00:00+00');
CREATE TABLE IF NOT EXISTS public.webhookevent_2026_12 PARTITION OF public.integrations_webhookevent
    FOR VALUES FROM ('2026-12-01 00:00:00+00') TO ('2027-01-01 00:00:00+00');
