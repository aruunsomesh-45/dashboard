-- =====================================================================================
-- Phase 3: data engineering & normalisation.
--
-- Additive: no table, column or row is dropped. Existing columns keep their meaning:
--   commerce_order.gross_amount = platform order TOTAL (Shopify total_price), minor units.
--   All money = BIGINT minor units (paise) + explicit ISO-4217 currency column.
--   All timestamps = TIMESTAMPTZ (UTC); reporting dates are computed in the brand's timezone.
--   New metric columns are NULLable: NULL = not provided by the platform, 0 = a real zero.
--
-- Two CHECK constraints are widened (supersets only) and one existing function is corrected
-- (refresh_daily_fact_shop bucketed orders on the wrong local date; see §10).
-- =====================================================================================

-- ─── 1. Raw ingestion layer (reuses integrations_rawpayload) ────────────────────────────
ALTER TABLE public.integrations_rawpayload
    ADD COLUMN IF NOT EXISTS source            VARCHAR(20) NOT NULL DEFAULT 'sync',
    ADD COLUMN IF NOT EXISTS payload_hash      VARCHAR(64) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS processing_status VARCHAR(20) NOT NULL DEFAULT 'pending',
    ADD COLUMN IF NOT EXISTS processed_at      TIMESTAMPTZ NULL,
    ADD COLUMN IF NOT EXISTS error             TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS attempts          INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS pii_redacted      BOOLEAN NOT NULL DEFAULT false;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_rawpayload_processing_status') THEN
        ALTER TABLE public.integrations_rawpayload ADD CONSTRAINT chk_rawpayload_processing_status
            CHECK (processing_status IN ('pending', 'processed', 'failed', 'skipped'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_rawpayload_source') THEN
        ALTER TABLE public.integrations_rawpayload ADD CONSTRAINT chk_rawpayload_source
            CHECK (source IN ('sync', 'webhook', 'backfill', 'reprocess'));
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_rawpayload_failed
    ON public.integrations_rawpayload (brand_id, provider, created_at)
    WHERE processing_status = 'failed';

-- Partitioned tables cannot carry a global unique index without the partition key, so
-- exact-duplicate suppression lives in a small side table (same pattern as webhook dedupe).
CREATE TABLE IF NOT EXISTS public.integrations_rawpayload_dedupe (
    brand_id        UUID         NOT NULL REFERENCES public.tenancy_brand(id) ON DELETE CASCADE,
    provider        VARCHAR(50)  NOT NULL,
    topic           VARCHAR(100) NOT NULL,
    entity_id       VARCHAR(255) NOT NULL,
    payload_hash    VARCHAR(64)  NOT NULL,
    rawpayload_id   UUID         NULL,
    rawpayload_created_at TIMESTAMPTZ NULL,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (brand_id, provider, topic, entity_id, payload_hash)
);
ALTER TABLE public.integrations_rawpayload_dedupe ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.integrations_rawpayload_dedupe FROM PUBLIC, anon, authenticated;

-- Stores one raw payload unless an identical one (same hash) was already stored.
CREATE OR REPLACE FUNCTION public.ingest_raw_payload(
    p_workspace_id UUID, p_brand_id UUID, p_provider TEXT, p_topic TEXT, p_entity_id TEXT,
    p_payload JSONB, p_payload_hash TEXT, p_source TEXT DEFAULT 'sync', p_pii_redacted BOOLEAN DEFAULT true)
RETURNS TABLE (id UUID, created_at TIMESTAMPTZ, duplicate BOOLEAN, processing_status TEXT)
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_inserted INT;
    v_id UUID;
    v_created TIMESTAMPTZ;
BEGIN
    IF p_payload_hash !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION 'ingest_raw_payload: payload hash must be a sha-256 hex digest' USING ERRCODE = '22023';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM tenancy_brand b WHERE b.id = p_brand_id AND b.workspace_id = p_workspace_id) THEN
        RAISE EXCEPTION 'ingest_raw_payload: brand does not belong to workspace' USING ERRCODE = '22023';
    END IF;

    INSERT INTO integrations_rawpayload_dedupe (brand_id, provider, topic, entity_id, payload_hash)
    VALUES (p_brand_id, p_provider, left(p_topic, 100), left(coalesce(p_entity_id, ''), 255), p_payload_hash)
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_inserted = ROW_COUNT;

    IF v_inserted = 0 THEN
        RETURN QUERY
        SELECT r.id, r.created_at, true, r.processing_status::text
          FROM integrations_rawpayload_dedupe d
          JOIN integrations_rawpayload r ON r.id = d.rawpayload_id AND r.created_at = d.rawpayload_created_at
         WHERE d.brand_id = p_brand_id AND d.provider = p_provider AND d.topic = left(p_topic, 100)
           AND d.entity_id = left(coalesce(p_entity_id, ''), 255) AND d.payload_hash = p_payload_hash;
        RETURN;
    END IF;

    INSERT INTO integrations_rawpayload (workspace_id, brand_id, provider, topic, entity_id, payload,
                                         source, payload_hash, processing_status, pii_redacted)
    VALUES (p_workspace_id, p_brand_id, p_provider, left(p_topic, 100), left(coalesce(p_entity_id, ''), 255), p_payload,
            p_source, p_payload_hash, 'pending', p_pii_redacted)
    RETURNING integrations_rawpayload.id, integrations_rawpayload.created_at INTO v_id, v_created;

    UPDATE integrations_rawpayload_dedupe d
       SET rawpayload_id = v_id, rawpayload_created_at = v_created
     WHERE d.brand_id = p_brand_id AND d.provider = p_provider AND d.topic = left(p_topic, 100)
       AND d.entity_id = left(coalesce(p_entity_id, ''), 255) AND d.payload_hash = p_payload_hash;

    RETURN QUERY SELECT v_id, v_created, false, 'pending'::text;
END;
$$;
REVOKE ALL ON FUNCTION public.ingest_raw_payload(UUID, UUID, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ingest_raw_payload(UUID, UUID, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, BOOLEAN) TO service_role;

-- Records the outcome of normalising one raw payload (attempts counts every try).
CREATE OR REPLACE FUNCTION public.mark_raw_payload(p_id UUID, p_created_at TIMESTAMPTZ, p_status TEXT, p_error TEXT DEFAULT '')
RETURNS VOID
LANGUAGE sql
SET search_path = public, pg_temp
AS $$
    UPDATE integrations_rawpayload
       SET processing_status = p_status,
           processed_at = clock_timestamp(),
           error = left(coalesce(p_error, ''), 2000),
           attempts = attempts + 1,
           replayed_at = CASE WHEN attempts > 0 THEN clock_timestamp() ELSE replayed_at END
     WHERE id = p_id AND created_at = p_created_at;
$$;
REVOKE ALL ON FUNCTION public.mark_raw_payload(UUID, TIMESTAMPTZ, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_raw_payload(UUID, TIMESTAMPTZ, TEXT, TEXT) TO service_role;

-- ─── 2. Orders ──────────────────────────────────────────────────────────────────────
ALTER TABLE public.commerce_order
    ADD COLUMN IF NOT EXISTS subtotal_amount           BIGINT NULL,
    ADD COLUMN IF NOT EXISTS refunded_amount           BIGINT NULL,
    ADD COLUMN IF NOT EXISTS taxes_included            BOOLEAN NULL,
    ADD COLUMN IF NOT EXISTS source_financial_status   VARCHAR(50)  NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS source_fulfillment_status VARCHAR(50)  NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS source_name               VARCHAR(100) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS cancel_reason             VARCHAR(50)  NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS payment_gateways          TEXT[]       NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS landing_path              VARCHAR(500) NULL,
    ADD COLUMN IF NOT EXISTS referring_domain          VARCHAR(255) NULL,
    ADD COLUMN IF NOT EXISTS utm_source                VARCHAR(255) NULL,
    ADD COLUMN IF NOT EXISTS utm_medium                VARCHAR(255) NULL,
    ADD COLUMN IF NOT EXISTS utm_campaign              VARCHAR(255) NULL,
    -- identifiers written by the checkout app (Razorpay Magic Checkout) into the order's note attributes
    ADD COLUMN IF NOT EXISTS gateway_payment_ref       VARCHAR(255) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS gateway_order_ref         VARCHAR(255) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS checkout_cart_token       VARCHAR(100) NOT NULL DEFAULT '';

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_commerce_order_new_amounts') THEN
        ALTER TABLE public.commerce_order ADD CONSTRAINT chk_commerce_order_new_amounts
            CHECK ((subtotal_amount IS NULL OR subtotal_amount >= 0) AND (refunded_amount IS NULL OR refunded_amount >= 0));
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_commerce_order_brand_number  ON public.commerce_order (brand_id, order_number);
CREATE INDEX IF NOT EXISTS idx_commerce_order_brand_updated ON public.commerce_order (brand_id, source_updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_commerce_order_gateway_payment ON public.commerce_order (brand_id, gateway_payment_ref) WHERE gateway_payment_ref <> '';
CREATE INDEX IF NOT EXISTS idx_commerce_order_cart_token ON public.commerce_order (brand_id, checkout_cart_token) WHERE checkout_cart_token <> '';

ALTER TABLE public.commerce_orderline
    ADD COLUMN IF NOT EXISTS provider_line_id    VARCHAR(255) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS provider_product_id VARCHAR(255) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS provider_variant_id VARCHAR(255) NOT NULL DEFAULT '';

-- Order history: one row per material change, written by trigger whatever the writer is.
CREATE TABLE IF NOT EXISTS public.commerce_order_history (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id           UUID NOT NULL REFERENCES public.commerce_order(id) ON DELETE CASCADE,
    workspace_id       UUID NOT NULL REFERENCES public.tenancy_workspace(id) ON DELETE CASCADE,
    brand_id           UUID NOT NULL REFERENCES public.tenancy_brand(id) ON DELETE CASCADE,
    change_kind        VARCHAR(10) NOT NULL CHECK (change_kind IN ('created', 'updated')),
    financial_status   VARCHAR(50) NOT NULL,
    fulfillment_status VARCHAR(50) NOT NULL,
    source_financial_status VARCHAR(50) NOT NULL DEFAULT '',
    gross_amount       BIGINT NOT NULL,
    net_sales          BIGINT NOT NULL,
    refunded_amount    BIGINT NULL,
    cancelled_at       TIMESTAMPTZ NULL,
    source_updated_at  TIMESTAMPTZ NULL,
    recorded_at        TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_order_history_order ON public.commerce_order_history (order_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_order_history_brand ON public.commerce_order_history (brand_id, recorded_at DESC);

CREATE OR REPLACE FUNCTION public.track_commerce_order_history()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND
       (NEW.financial_status, NEW.fulfillment_status, NEW.source_financial_status, NEW.gross_amount,
        NEW.net_sales, NEW.refunded_amount, NEW.cancelled_at)
       IS NOT DISTINCT FROM
       (OLD.financial_status, OLD.fulfillment_status, OLD.source_financial_status, OLD.gross_amount,
        OLD.net_sales, OLD.refunded_amount, OLD.cancelled_at) THEN
        RETURN NEW;
    END IF;
    INSERT INTO commerce_order_history (order_id, workspace_id, brand_id, change_kind, financial_status,
        fulfillment_status, source_financial_status, gross_amount, net_sales, refunded_amount, cancelled_at, source_updated_at)
    VALUES (NEW.id, NEW.workspace_id, NEW.brand_id, CASE WHEN TG_OP = 'INSERT' THEN 'created' ELSE 'updated' END,
        NEW.financial_status, NEW.fulfillment_status, NEW.source_financial_status, NEW.gross_amount, NEW.net_sales,
        NEW.refunded_amount, NEW.cancelled_at, NEW.source_updated_at);
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.track_commerce_order_history() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_commerce_order_history ON public.commerce_order;
CREATE TRIGGER trg_commerce_order_history
AFTER INSERT OR UPDATE ON public.commerce_order
FOR EACH ROW EXECUTE FUNCTION public.track_commerce_order_history();

-- ─── 3. Payments & refunds ─────────────────────────────────────────────────────────────
ALTER TABLE public.commerce_paymentattempt
    ADD COLUMN IF NOT EXISTS source_status         VARCHAR(50)  NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS refunded_amount_minor BIGINT       NULL,
    ADD COLUMN IF NOT EXISTS refund_status         VARCHAR(20)  NULL,
    ADD COLUMN IF NOT EXISTS merchant_order_ref    VARCHAR(255) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS merchant_order_ref_key VARCHAR(60) NOT NULL DEFAULT '';

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_commerce_payment_refund') THEN
        ALTER TABLE public.commerce_paymentattempt ADD CONSTRAINT chk_commerce_payment_refund
            CHECK ((refunded_amount_minor IS NULL OR refunded_amount_minor >= 0)
               AND (refund_status IS NULL OR refund_status IN ('partial', 'full')));
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_payment_brand_order_ref
    ON public.commerce_paymentattempt (brand_id, merchant_order_ref) WHERE merchant_order_ref <> '';

CREATE TABLE IF NOT EXISTS public.commerce_refund (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id        UUID NOT NULL REFERENCES public.tenancy_workspace(id) ON DELETE CASCADE,
    brand_id            UUID NOT NULL REFERENCES public.tenancy_brand(id) ON DELETE CASCADE,
    provider            VARCHAR(50)  NOT NULL,
    provider_id         VARCHAR(255) NOT NULL,
    order_id            UUID NULL REFERENCES public.commerce_order(id) ON DELETE SET NULL,
    payment_attempt_id  UUID NULL REFERENCES public.commerce_paymentattempt(id) ON DELETE SET NULL,
    order_provider_id   VARCHAR(255) NOT NULL DEFAULT '',
    payment_provider_id VARCHAR(255) NOT NULL DEFAULT '',
    amount_minor        BIGINT NOT NULL CHECK (amount_minor >= 0),
    currency            VARCHAR(3) NOT NULL,
    status              VARCHAR(20) NOT NULL CHECK (status IN ('pending', 'processed', 'failed')),
    source_status       VARCHAR(50) NOT NULL DEFAULT '',
    reason              VARCHAR(255) NOT NULL DEFAULT '',
    source_created_at   TIMESTAMPTZ NULL,
    source_updated_at   TIMESTAMPTZ NULL,
    raw_payload_ref     VARCHAR(255) NOT NULL DEFAULT '',
    ingested_at         TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_commerce_refund_brand_provider UNIQUE (brand_id, provider, provider_id),
    CONSTRAINT chk_commerce_refund_currency CHECK (currency ~ '^[A-Z]{3}$')
);
CREATE INDEX IF NOT EXISTS idx_refund_order   ON public.commerce_refund (order_id);
CREATE INDEX IF NOT EXISTS idx_refund_payment ON public.commerce_refund (payment_attempt_id);
CREATE INDEX IF NOT EXISTS idx_refund_brand_created ON public.commerce_refund (brand_id, source_created_at DESC);
DROP TRIGGER IF EXISTS trg_commerce_refund_updated_at ON public.commerce_refund;
CREATE TRIGGER trg_commerce_refund_updated_at BEFORE UPDATE ON public.commerce_refund
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ─── 4. Shipments ───────────────────────────────────────────────────────────────────────
ALTER TABLE public.commerce_shipment DROP CONSTRAINT IF EXISTS chk_commerce_shipment_canonical_status;
ALTER TABLE public.commerce_shipment ADD CONSTRAINT chk_commerce_shipment_canonical_status
    CHECK (canonical_status IN ('created', 'pickup_pending', 'picked_up', 'in_transit', 'out_for_delivery',
                                'delivered', 'ndr', 'rto_initiated', 'rto_in_transit', 'rto_delivered',
                                'returned', 'cancelled', 'unknown'));

ALTER TABLE public.commerce_shipment
    ADD COLUMN IF NOT EXISTS order_ref        VARCHAR(255) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS picked_up_at     TIMESTAMPTZ NULL,
    ADD COLUMN IF NOT EXISTS last_tracking_at TIMESTAMPTZ NULL,
    ADD COLUMN IF NOT EXISTS return_status    VARCHAR(20) NULL,
    ADD COLUMN IF NOT EXISTS payment_mode     VARCHAR(20) NULL;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_commerce_shipment_return_status') THEN
        ALTER TABLE public.commerce_shipment ADD CONSTRAINT chk_commerce_shipment_return_status
            CHECK (return_status IS NULL OR return_status IN ('rto_initiated', 'rto_in_transit', 'rto_delivered', 'returned'));
    END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_shipment_brand_order_ref ON public.commerce_shipment (brand_id, order_ref) WHERE order_ref <> '';

ALTER TABLE public.commerce_trackingevent
    ADD COLUMN IF NOT EXISTS raw_status       VARCHAR(100) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS source_code      VARCHAR(50)  NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS canonical_status VARCHAR(30)  NULL,
    ADD COLUMN IF NOT EXISTS ingested_at      TIMESTAMPTZ  NOT NULL DEFAULT clock_timestamp();
-- A tracking scan is identified by when/where/what; re-fetching the same scan never duplicates it.
CREATE UNIQUE INDEX IF NOT EXISTS uq_trackingevent_scan
    ON public.commerce_trackingevent (shipment_id, occurred_at, raw_status, location);

-- ─── 5. Marketing (paid Meta and organic Instagram are kept in separate tables) ─────────
CREATE TABLE IF NOT EXISTS public.analytics_meta_ad_daily (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id         UUID NOT NULL REFERENCES public.tenancy_workspace(id) ON DELETE CASCADE,
    brand_id             UUID NOT NULL REFERENCES public.tenancy_brand(id) ON DELETE CASCADE,
    ad_account_id        VARCHAR(50)  NOT NULL,
    campaign_id          VARCHAR(50)  NOT NULL,
    campaign_name        VARCHAR(500) NOT NULL DEFAULT '',
    adset_id             VARCHAR(50)  NOT NULL,
    adset_name           VARCHAR(500) NOT NULL DEFAULT '',
    ad_id                VARCHAR(50)  NOT NULL,
    ad_name              VARCHAR(500) NOT NULL DEFAULT '',
    report_date          DATE NOT NULL,
    attribution_setting  VARCHAR(100) NOT NULL DEFAULT 'account_default',
    currency             VARCHAR(3)   NOT NULL,
    spend_minor          BIGINT  NULL CHECK (spend_minor >= 0),
    impressions          BIGINT  NULL CHECK (impressions >= 0),
    reach                BIGINT  NULL CHECK (reach >= 0),
    clicks               BIGINT  NULL CHECK (clicks >= 0),
    purchases            INTEGER NULL CHECK (purchases >= 0),
    purchase_value_minor BIGINT  NULL CHECK (purchase_value_minor >= 0),
    meta_cpm             NUMERIC(18, 6) NULL,   -- as reported by Meta (its own definition)
    meta_cpc             NUMERIC(18, 6) NULL,
    meta_ctr             NUMERIC(18, 6) NULL,   -- Meta reports CTR in percent
    source_metrics       JSONB NOT NULL DEFAULT '{}'::jsonb,  -- untouched actions/action_values arrays
    fetched_at           TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    created_at           TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_meta_ad_daily UNIQUE (brand_id, ad_id, report_date, attribution_setting),
    CONSTRAINT chk_meta_ad_daily_currency CHECK (currency ~ '^[A-Z]{3}$')
);
CREATE INDEX IF NOT EXISTS idx_meta_ad_daily_brand_date ON public.analytics_meta_ad_daily (brand_id, report_date DESC);
CREATE INDEX IF NOT EXISTS idx_meta_ad_daily_campaign   ON public.analytics_meta_ad_daily (brand_id, campaign_id, report_date DESC);
DROP TRIGGER IF EXISTS trg_meta_ad_daily_updated_at ON public.analytics_meta_ad_daily;
CREATE TRIGGER trg_meta_ad_daily_updated_at BEFORE UPDATE ON public.analytics_meta_ad_daily
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Derived ratios are computed, never stored, and stay NULL when the denominator is missing/zero.
CREATE OR REPLACE VIEW public.analytics_meta_ad_daily_metrics
WITH (security_invoker = true) AS
SELECT d.*,
       CASE WHEN d.impressions > 0 AND d.spend_minor IS NOT NULL
            THEN round(d.spend_minor::numeric / 100 / d.impressions * 1000, 4) END AS cpm,
       CASE WHEN d.clicks > 0 AND d.spend_minor IS NOT NULL
            THEN round(d.spend_minor::numeric / 100 / d.clicks, 4) END AS cpc,
       CASE WHEN d.impressions > 0 AND d.clicks IS NOT NULL
            THEN round(d.clicks::numeric / d.impressions * 100, 4) END AS ctr_pct,
       CASE WHEN d.spend_minor > 0 AND d.purchase_value_minor IS NOT NULL
            THEN round(d.purchase_value_minor::numeric / d.spend_minor, 4) END AS roas
  FROM public.analytics_meta_ad_daily d;

CREATE TABLE IF NOT EXISTS public.analytics_instagram_media (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id       UUID NOT NULL REFERENCES public.tenancy_workspace(id) ON DELETE CASCADE,
    brand_id           UUID NOT NULL REFERENCES public.tenancy_brand(id) ON DELETE CASCADE,
    ig_account_id      VARCHAR(50)  NOT NULL,
    media_id           VARCHAR(50)  NOT NULL,
    media_type         VARCHAR(30)  NOT NULL DEFAULT '',
    media_product_type VARCHAR(30)  NOT NULL DEFAULT '',
    permalink          VARCHAR(500) NOT NULL DEFAULT '',
    published_at       TIMESTAMPTZ  NULL,
    created_at         TIMESTAMPTZ  NOT NULL DEFAULT clock_timestamp(),
    updated_at         TIMESTAMPTZ  NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_instagram_media UNIQUE (brand_id, media_id)
);
DROP TRIGGER IF EXISTS trg_instagram_media_updated_at ON public.analytics_instagram_media;
CREATE TRIGGER trg_instagram_media_updated_at BEFORE UPDATE ON public.analytics_instagram_media
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Instagram media insights are lifetime counters: one snapshot per media per day.
CREATE TABLE IF NOT EXISTS public.analytics_instagram_media_snapshot (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id       UUID NOT NULL REFERENCES public.tenancy_workspace(id) ON DELETE CASCADE,
    brand_id           UUID NOT NULL REFERENCES public.tenancy_brand(id) ON DELETE CASCADE,
    media_id           VARCHAR(50) NOT NULL,
    snapshot_date      DATE NOT NULL,
    reach              BIGINT NULL CHECK (reach >= 0),
    impressions        BIGINT NULL CHECK (impressions >= 0),  -- NULL for media where Meta no longer reports it
    views              BIGINT NULL CHECK (views >= 0),
    likes              BIGINT NULL CHECK (likes >= 0),
    comments           BIGINT NULL CHECK (comments >= 0),
    shares             BIGINT NULL CHECK (shares >= 0),
    saves              BIGINT NULL CHECK (saves >= 0),
    total_interactions BIGINT NULL CHECK (total_interactions >= 0),
    source_metrics     JSONB NOT NULL DEFAULT '{}'::jsonb,
    fetched_at         TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_instagram_media_snapshot UNIQUE (brand_id, media_id, snapshot_date)
);
CREATE INDEX IF NOT EXISTS idx_instagram_snapshot_brand_date ON public.analytics_instagram_media_snapshot (brand_id, snapshot_date DESC);

-- ─── 6. Google Analytics 4 ────────────────────────────────────────────────────────────────
-- Dimensions are stored exactly as GA4 returns them, including the literal '(not set)'.
-- total_users is NOT additive across rows (GA4 de-duplicates users per query): never SUM it.
CREATE TABLE IF NOT EXISTS public.analytics_ga4_daily (
    id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id           UUID NOT NULL REFERENCES public.tenancy_workspace(id) ON DELETE CASCADE,
    brand_id               UUID NOT NULL REFERENCES public.tenancy_brand(id) ON DELETE CASCADE,
    property_id            VARCHAR(30)  NOT NULL,
    report_date            DATE NOT NULL,
    session_source         VARCHAR(255) NOT NULL,
    session_medium         VARCHAR(255) NOT NULL,
    session_campaign       VARCHAR(255) NOT NULL,
    landing_page           VARCHAR(1000) NOT NULL,
    device_category        VARCHAR(30)  NOT NULL,
    sessions               BIGINT NULL CHECK (sessions >= 0),
    total_users            BIGINT NULL CHECK (total_users >= 0),
    new_users              BIGINT NULL CHECK (new_users >= 0),
    screen_page_views      BIGINT NULL CHECK (screen_page_views >= 0),
    key_events             NUMERIC(18, 2) NULL CHECK (key_events >= 0),
    transactions           BIGINT NULL CHECK (transactions >= 0),
    purchase_revenue_minor BIGINT NULL,
    currency               VARCHAR(3) NOT NULL,
    fetched_at             TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_ga4_daily UNIQUE (brand_id, property_id, report_date, session_source, session_medium,
                                    session_campaign, landing_page, device_category),
    CONSTRAINT chk_ga4_daily_currency CHECK (currency ~ '^[A-Z]{3}$')
);
CREATE INDEX IF NOT EXISTS idx_ga4_daily_brand_date ON public.analytics_ga4_daily (brand_id, report_date DESC);

CREATE TABLE IF NOT EXISTS public.analytics_ga4_transaction (
    id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id           UUID NOT NULL REFERENCES public.tenancy_workspace(id) ON DELETE CASCADE,
    brand_id               UUID NOT NULL REFERENCES public.tenancy_brand(id) ON DELETE CASCADE,
    property_id            VARCHAR(30)  NOT NULL,
    transaction_id         VARCHAR(255) NOT NULL,
    report_date            DATE NOT NULL,
    session_source         VARCHAR(255) NOT NULL,
    session_medium         VARCHAR(255) NOT NULL,
    session_campaign       VARCHAR(255) NOT NULL,
    purchase_revenue_minor BIGINT NULL,
    currency               VARCHAR(3) NOT NULL,
    fetched_at             TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_ga4_transaction UNIQUE (brand_id, property_id, transaction_id)
);
CREATE INDEX IF NOT EXISTS idx_ga4_transaction_lookup ON public.analytics_ga4_transaction (brand_id, transaction_id);

-- ─── 7. Customer metrics (computed from orders, not trusted from the source) ────────────────
CREATE OR REPLACE VIEW public.commerce_customer_metrics
WITH (security_invoker = true) AS
SELECT c.id AS customer_id, c.workspace_id, c.brand_id, c.provider, c.provider_id,
       c.source_created_at AS customer_created_at,
       min(o.source_created_at) AS first_order_at,
       max(o.source_created_at) AS latest_order_at,
       count(o.id)::int AS order_count,
       coalesce(sum(o.gross_amount - coalesce(o.refunded_amount, 0)), 0)::bigint AS lifetime_value_minor,
       count(DISTINCT o.currency) AS currencies   -- > 1 means lifetime value mixes currencies
  FROM public.commerce_customer c
  LEFT JOIN public.commerce_order o
         ON o.customer_id = c.id AND o.financial_status <> 'voided' AND o.cancelled_at IS NULL
 GROUP BY c.id;

-- ─── 8. Reconciliation & data quality stores ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.commerce_reconciliation (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id     UUID NOT NULL REFERENCES public.tenancy_workspace(id) ON DELETE CASCADE,
    brand_id         UUID NOT NULL REFERENCES public.tenancy_brand(id) ON DELETE CASCADE,
    entity_type      VARCHAR(30) NOT NULL CHECK (entity_type IN ('payment', 'order_payment', 'shipment', 'refund', 'order_attribution')),
    entity_id        UUID NOT NULL,
    status           VARCHAR(20) NOT NULL CHECK (status IN ('MATCHED', 'UNMATCHED', 'PARTIALLY_MATCHED', 'NEEDS_REVIEW')),
    matched_order_id UUID NULL REFERENCES public.commerce_order(id) ON DELETE SET NULL,
    match_method     VARCHAR(50) NOT NULL DEFAULT '',
    confidence       NUMERIC(3, 2) NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 1),
    details          JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_reconciliation_entity UNIQUE (entity_type, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_reconciliation_brand_status ON public.commerce_reconciliation (brand_id, entity_type, status);

CREATE TABLE IF NOT EXISTS public.data_quality_issue (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id  UUID NOT NULL REFERENCES public.tenancy_workspace(id) ON DELETE CASCADE,
    brand_id      UUID NOT NULL REFERENCES public.tenancy_brand(id) ON DELETE CASCADE,
    check_key     VARCHAR(60) NOT NULL,
    severity      VARCHAR(10) NOT NULL CHECK (severity IN ('error', 'warning', 'info')),
    entity_table  VARCHAR(60) NOT NULL,
    entity_id     UUID NOT NULL,
    message       TEXT NOT NULL,
    details       JSONB NOT NULL DEFAULT '{}'::jsonb,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    resolved_at   TIMESTAMPTZ NULL,
    CONSTRAINT uq_data_quality_issue UNIQUE (brand_id, check_key, entity_table, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_dq_open ON public.data_quality_issue (brand_id, severity) WHERE resolved_at IS NULL;

-- ─── 9. Row level security for every new table: members read their brands, only the service role writes
DO $$
DECLARE
    v_tbl TEXT;
BEGIN
    FOREACH v_tbl IN ARRAY ARRAY['commerce_order_history', 'commerce_refund', 'analytics_meta_ad_daily',
        'analytics_instagram_media', 'analytics_instagram_media_snapshot', 'analytics_ga4_daily',
        'analytics_ga4_transaction', 'commerce_reconciliation', 'data_quality_issue'] LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_tbl);
        EXECUTE format('DROP POLICY IF EXISTS rls_%s_select ON public.%I', v_tbl, v_tbl);
        EXECUTE format('CREATE POLICY rls_%s_select ON public.%I FOR SELECT TO authenticated, app_user USING (public.has_brand_access(brand_id))', v_tbl, v_tbl);
        EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon', v_tbl);
        EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.%I FROM authenticated', v_tbl);
        EXECUTE format('GRANT SELECT ON public.%I TO authenticated', v_tbl);
        EXECUTE format('GRANT ALL ON public.%I TO service_role', v_tbl);
    END LOOP;
END $$;

REVOKE ALL ON public.analytics_meta_ad_daily_metrics, public.commerce_customer_metrics FROM PUBLIC, anon;
GRANT SELECT ON public.analytics_meta_ad_daily_metrics, public.commerce_customer_metrics TO authenticated, service_role;

-- ─── 10. Fix: daily facts used the wrong local date ────────────────────────────────────────
-- `ts AT TIME ZONE 'UTC' AT TIME ZONE tz` converts in the wrong direction under a UTC session,
-- dating every order placed before 11:00 IST on the previous day. Correct: `ts AT TIME ZONE tz`.
-- Also: a signed-in caller may only refresh brands where they are owner/admin.
CREATE OR REPLACE FUNCTION public.refresh_daily_fact_shop(p_brand_id UUID, p_target_date DATE)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_workspace_id UUID;
    v_tz VARCHAR(50);
BEGIN
    SELECT workspace_id, timezone INTO v_workspace_id, v_tz FROM public.tenancy_brand WHERE id = p_brand_id;
    IF v_workspace_id IS NULL THEN
        RAISE EXCEPTION 'refresh_daily_fact_shop: unknown brand' USING ERRCODE = '22023';
    END IF;
    IF (SELECT auth.uid()) IS NOT NULL AND NOT public.has_workspace_role(v_workspace_id, ARRAY['owner', 'admin']) THEN
        RAISE EXCEPTION 'refresh_daily_fact_shop: not allowed for this brand' USING ERRCODE = '42501';
    END IF;

    INSERT INTO public.analytics_factshopdaily (
        workspace_id, brand_id, fact_date, gross_sales, discount_amount, tax_amount, shipping_amount,
        net_sales, orders_count, customers_count, items_count, fulfilled_orders_count, unfulfilled_orders_count, updated_at)
    SELECT v_workspace_id, p_brand_id, p_target_date,
        COALESCE(SUM(o.gross_amount), 0), COALESCE(SUM(o.discount_amount), 0), COALESCE(SUM(o.tax_amount), 0),
        COALESCE(SUM(o.shipping_amount), 0), COALESCE(SUM(o.net_sales), 0), COUNT(o.id), COUNT(DISTINCT o.customer_id),
        COALESCE(SUM(ol.items_total), 0),
        COUNT(CASE WHEN o.fulfillment_status = 'fulfilled' THEN 1 END),
        COUNT(CASE WHEN o.fulfillment_status = 'unfulfilled' THEN 1 END),
        clock_timestamp()
    FROM public.commerce_order o
    LEFT JOIN (SELECT order_id, SUM(quantity) AS items_total FROM public.commerce_orderline GROUP BY order_id) ol
           ON ol.order_id = o.id
    WHERE o.brand_id = p_brand_id
      AND (o.source_created_at AT TIME ZONE v_tz)::DATE = p_target_date
      AND o.financial_status != 'voided'
    ON CONFLICT (brand_id, fact_date) DO UPDATE SET
        gross_sales = EXCLUDED.gross_sales, discount_amount = EXCLUDED.discount_amount,
        tax_amount = EXCLUDED.tax_amount, shipping_amount = EXCLUDED.shipping_amount,
        net_sales = EXCLUDED.net_sales, orders_count = EXCLUDED.orders_count,
        customers_count = EXCLUDED.customers_count, items_count = EXCLUDED.items_count,
        fulfilled_orders_count = EXCLUDED.fulfilled_orders_count,
        unfulfilled_orders_count = EXCLUDED.unfulfilled_orders_count, updated_at = clock_timestamp();
END;
$$;
REVOKE ALL ON FUNCTION public.refresh_daily_fact_shop(UUID, DATE) FROM PUBLIC, anon;

-- ─── 11. Reconciliation engine ──────────────────────────────────────────────────────────────
-- Links are created ONLY from exact identifiers. Amount/time look-alikes are reported as
-- NEEDS_REVIEW with their candidates and are never linked automatically.
CREATE OR REPLACE FUNCTION public.reconcile_brand(p_brand_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_ws UUID;
    v_now TIMESTAMPTZ := clock_timestamp();
    v_pay_links INT;
    v_ship_links INT;
    v_variants INT;
    v_refund_links INT := 0;
    v_n INT;
BEGIN
    SELECT workspace_id INTO v_ws FROM tenancy_brand WHERE id = p_brand_id;
    IF v_ws IS NULL THEN
        RAISE EXCEPTION 'reconcile_brand: unknown brand %', p_brand_id USING ERRCODE = '22023';
    END IF;

    -- (a0) order -> payment: the Shopify order carries the gateway payment id (Magic Checkout note
    --      attribute razorpay_payment_id). Exact and one-to-one: the strongest identifier available.
    WITH refs AS (
        SELECT o.id AS order_id, p.id AS payment_id
          FROM commerce_order o
          JOIN commerce_paymentattempt p
            ON p.brand_id = o.brand_id AND p.provider = 'razorpay' AND p.provider_id = o.gateway_payment_ref
         WHERE o.brand_id = p_brand_id AND o.gateway_payment_ref <> ''
           AND NOT EXISTS (SELECT 1 FROM commerce_orderpaymentlink l WHERE l.payment_attempt_id = p.id)
    )
    INSERT INTO commerce_orderpaymentlink (order_id, payment_attempt_id, match_method, confidence)
    SELECT order_id, payment_id, 'order_payment_id', 1.00 FROM refs
    ON CONFLICT (order_id, payment_attempt_id) DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;

    -- (a) payment -> order: the payment carries the Shopify order id/number, and it names exactly one order
    WITH refs AS (
        SELECT p.id AS payment_id, o.id AS order_id,
               CASE WHEN o.provider_id = p.merchant_order_ref THEN 1.00 ELSE 0.95 END AS conf
          FROM commerce_paymentattempt p
          JOIN commerce_order o
            ON o.brand_id = p.brand_id AND o.provider = 'shopify'
           AND (o.provider_id = p.merchant_order_ref OR o.order_number = ltrim(p.merchant_order_ref, '#'))
         WHERE p.brand_id = p_brand_id AND p.merchant_order_ref <> ''
           AND NOT EXISTS (SELECT 1 FROM commerce_orderpaymentlink l WHERE l.payment_attempt_id = p.id)
    ), uniq AS (
        SELECT payment_id, (array_agg(order_id))[1] AS order_id, max(conf) AS conf
          FROM refs GROUP BY payment_id HAVING count(DISTINCT order_id) = 1
    )
    INSERT INTO commerce_orderpaymentlink (order_id, payment_attempt_id, match_method, confidence)
    SELECT order_id, payment_id, CASE WHEN conf = 1.00 THEN 'notes_order_id' ELSE 'notes_order_number' END, conf FROM uniq
    ON CONFLICT (order_id, payment_attempt_id) DO NOTHING;
    GET DIAGNOSTICS v_pay_links = ROW_COUNT;
    v_pay_links := v_pay_links + v_n;

    -- (b) payment-level status
    INSERT INTO commerce_reconciliation AS r (workspace_id, brand_id, entity_type, entity_id, status, matched_order_id, match_method, confidence, details, updated_at)
    SELECT v_ws, p_brand_id, 'payment', p.id,
           CASE WHEN lk.n = 1 THEN 'MATCHED' WHEN lk.n > 1 THEN 'NEEDS_REVIEW'
                WHEN c.n IS NOT NULL OR amb.n IS NOT NULL THEN 'NEEDS_REVIEW' ELSE 'UNMATCHED' END,
           CASE WHEN lk.n = 1 THEN lk.order_id END,
           CASE WHEN lk.n >= 1 THEN lk.method WHEN amb.n IS NOT NULL THEN 'ambiguous_order_ref'
                WHEN c.n IS NOT NULL THEN 'amount_time_candidate' ELSE '' END,
           CASE WHEN lk.n = 1 THEN lk.conf WHEN lk.n > 1 THEN 0.50 WHEN amb.n IS NOT NULL THEN 0.40
                WHEN c.n = 1 THEN 0.60 WHEN c.n > 1 THEN 0.30 ELSE 0 END,
           jsonb_strip_nulls(jsonb_build_object(
               'payment_status', p.status,
               'linked_orders', lk.n,
               'candidates', coalesce(amb.candidates, c.candidates),
               'reason', CASE
                   WHEN lk.n > 1 THEN 'payment is linked to more than one order'
                   WHEN lk.n IS NULL AND amb.n IS NOT NULL THEN 'order reference on the payment matches several orders'
                   WHEN lk.n IS NULL AND c.n IS NOT NULL THEN 'no order reference; same amount and currency within 30 minutes - confirm manually'
                   WHEN lk.n IS NULL THEN 'no order reference on the payment and no candidate order' END)),
           v_now
      FROM commerce_paymentattempt p
      LEFT JOIN LATERAL (
          SELECT count(*)::int AS n, (array_agg(l.order_id))[1] AS order_id, (array_agg(l.match_method))[1] AS method, max(l.confidence) AS conf
            FROM commerce_orderpaymentlink l WHERE l.payment_attempt_id = p.id HAVING count(*) > 0) lk ON true
      LEFT JOIN LATERAL (
          SELECT count(DISTINCT o.id)::int AS n, jsonb_agg(DISTINCT jsonb_build_object('order_id', o.id, 'order_number', o.order_number)) AS candidates
            FROM commerce_order o
           WHERE lk.n IS NULL AND p.merchant_order_ref <> '' AND o.brand_id = p.brand_id AND o.provider = 'shopify'
             AND (o.provider_id = p.merchant_order_ref OR o.order_number = ltrim(p.merchant_order_ref, '#'))
          HAVING count(DISTINCT o.id) > 1) amb ON true
      LEFT JOIN LATERAL (
          SELECT count(*)::int AS n, jsonb_agg(jsonb_build_object('order_id', o.id, 'order_number', o.order_number) ORDER BY o.source_created_at) AS candidates
            FROM commerce_order o
           WHERE lk.n IS NULL AND amb.n IS NULL AND o.brand_id = p.brand_id AND o.provider = 'shopify'
             AND o.currency = p.currency AND o.gross_amount = p.amount_minor
             AND p.source_created_at IS NOT NULL
             AND o.source_created_at BETWEEN p.source_created_at - INTERVAL '30 minutes' AND p.source_created_at + INTERVAL '30 minutes'
          HAVING count(*) > 0) c ON true
     WHERE p.brand_id = p_brand_id
    ON CONFLICT (entity_type, entity_id) DO UPDATE
       SET status = EXCLUDED.status, matched_order_id = EXCLUDED.matched_order_id, match_method = EXCLUDED.match_method,
           confidence = EXCLUDED.confidence, details = EXCLUDED.details, updated_at = EXCLUDED.updated_at
     WHERE (r.status, r.matched_order_id, r.match_method, r.confidence, r.details)
           IS DISTINCT FROM (EXCLUDED.status, EXCLUDED.matched_order_id, EXCLUDED.match_method, EXCLUDED.confidence, EXCLUDED.details);

    -- (c) order-level payment completeness, only for orders the platform says were paid through Razorpay
    INSERT INTO commerce_reconciliation AS r (workspace_id, brand_id, entity_type, entity_id, status, matched_order_id, match_method, confidence, details, updated_at)
    SELECT v_ws, p_brand_id, 'order_payment', o.id,
           CASE WHEN coalesce(s.captured, 0) = 0 THEN 'UNMATCHED'
                WHEN s.currency_mismatch THEN 'NEEDS_REVIEW'
                WHEN s.captured = o.gross_amount THEN 'MATCHED'
                WHEN s.captured < o.gross_amount THEN 'PARTIALLY_MATCHED'
                ELSE 'NEEDS_REVIEW' END,
           o.id, 'payment_links',
           CASE WHEN coalesce(s.captured, 0) = 0 THEN 0 WHEN s.captured = o.gross_amount AND NOT s.currency_mismatch THEN 1.00 ELSE 0.50 END,
           jsonb_build_object('order_total_minor', o.gross_amount, 'captured_minor', coalesce(s.captured, 0),
                              'linked_payments', coalesce(s.n, 0), 'failed_attempts', coalesce(s.failed, 0),
                              'reason', CASE WHEN coalesce(s.captured, 0) = 0 THEN 'no captured Razorpay payment linked to this order'
                                             WHEN s.currency_mismatch THEN 'linked payment currency differs from order currency'
                                             WHEN s.captured > o.gross_amount THEN 'captured amount exceeds order total (possible double payment)'
                                             WHEN s.captured < o.gross_amount THEN 'captured amount is less than the order total' END),
           v_now
      FROM commerce_order o
      LEFT JOIN LATERAL (
          SELECT sum(p.amount_minor) FILTER (WHERE p.status IN ('captured', 'refunded')) AS captured,
                 count(*)::int AS n, count(*) FILTER (WHERE p.status = 'failed')::int AS failed,
                 coalesce(bool_or(p.currency <> o.currency), false) AS currency_mismatch
            FROM commerce_orderpaymentlink l JOIN commerce_paymentattempt p ON p.id = l.payment_attempt_id
           WHERE l.order_id = o.id) s ON true
     WHERE o.brand_id = p_brand_id AND o.provider = 'shopify' AND o.financial_status <> 'voided'
       AND EXISTS (SELECT 1 FROM unnest(o.payment_gateways) g WHERE g ILIKE '%razorpay%')
    ON CONFLICT (entity_type, entity_id) DO UPDATE
       SET status = EXCLUDED.status, matched_order_id = EXCLUDED.matched_order_id, match_method = EXCLUDED.match_method,
           confidence = EXCLUDED.confidence, details = EXCLUDED.details, updated_at = EXCLUDED.updated_at
     WHERE (r.status, r.confidence, r.details) IS DISTINCT FROM (EXCLUDED.status, EXCLUDED.confidence, EXCLUDED.details);

    -- (d) shipment -> order by the order reference the courier holds (e.g. Delhivery ReferenceNo)
    WITH refs AS (
        SELECT s.id AS shipment_id, o.id AS order_id
          FROM commerce_shipment s
          JOIN commerce_order o
            ON o.brand_id = s.brand_id AND o.provider = 'shopify'
           AND (o.provider_id = s.order_ref OR o.order_number = ltrim(s.order_ref, '#'))
         WHERE s.brand_id = p_brand_id AND s.order_ref <> ''
           AND NOT EXISTS (SELECT 1 FROM commerce_ordershipmentlink l WHERE l.shipment_id = s.id)
    ), uniq AS (
        SELECT shipment_id, (array_agg(order_id))[1] AS order_id FROM refs GROUP BY shipment_id HAVING count(DISTINCT order_id) = 1
    )
    INSERT INTO commerce_ordershipmentlink (order_id, shipment_id, match_method, confidence)
    SELECT order_id, shipment_id, 'order_reference', 1.00 FROM uniq
    ON CONFLICT (order_id, shipment_id) DO NOTHING;
    GET DIAGNOSTICS v_ship_links = ROW_COUNT;

    INSERT INTO commerce_reconciliation AS r (workspace_id, brand_id, entity_type, entity_id, status, matched_order_id, match_method, confidence, details, updated_at)
    SELECT v_ws, p_brand_id, 'shipment', s.id,
           CASE WHEN lk.n = 1 THEN 'MATCHED' WHEN lk.n > 1 OR amb.n > 1 THEN 'NEEDS_REVIEW' ELSE 'UNMATCHED' END,
           CASE WHEN lk.n = 1 THEN lk.order_id END,
           CASE WHEN lk.n >= 1 THEN 'order_reference' WHEN amb.n > 1 THEN 'ambiguous_order_ref' ELSE '' END,
           CASE WHEN lk.n = 1 THEN 1.00 WHEN lk.n > 1 OR amb.n > 1 THEN 0.40 ELSE 0 END,
           jsonb_strip_nulls(jsonb_build_object('awb', s.awb, 'order_ref', nullif(s.order_ref, ''),
               'candidates', amb.candidates,
               'reason', CASE WHEN lk.n > 1 THEN 'shipment linked to more than one order'
                              WHEN lk.n IS NULL AND amb.n > 1 THEN 'order reference matches several orders'
                              WHEN lk.n IS NULL AND s.order_ref = '' THEN 'courier record carries no order reference'
                              WHEN lk.n IS NULL THEN 'no order with this reference' END)),
           v_now
      FROM commerce_shipment s
      LEFT JOIN LATERAL (SELECT count(*)::int AS n, (array_agg(l.order_id))[1] AS order_id
                           FROM commerce_ordershipmentlink l WHERE l.shipment_id = s.id HAVING count(*) > 0) lk ON true
      LEFT JOIN LATERAL (SELECT count(DISTINCT o.id)::int AS n, jsonb_agg(DISTINCT jsonb_build_object('order_id', o.id, 'order_number', o.order_number)) AS candidates
                           FROM commerce_order o
                          WHERE lk.n IS NULL AND s.order_ref <> '' AND o.brand_id = s.brand_id AND o.provider = 'shopify'
                            AND (o.provider_id = s.order_ref OR o.order_number = ltrim(s.order_ref, '#'))) amb ON true
     WHERE s.brand_id = p_brand_id
    ON CONFLICT (entity_type, entity_id) DO UPDATE
       SET status = EXCLUDED.status, matched_order_id = EXCLUDED.matched_order_id, match_method = EXCLUDED.match_method,
           confidence = EXCLUDED.confidence, details = EXCLUDED.details, updated_at = EXCLUDED.updated_at
     WHERE (r.status, r.matched_order_id, r.details) IS DISTINCT FROM (EXCLUDED.status, EXCLUDED.matched_order_id, EXCLUDED.details);

    -- (e) refunds: Razorpay refund -> payment by payment id (exact); refund -> order via the Shopify
    --     order id, or via the payment's single order link.
    UPDATE commerce_refund rf SET payment_attempt_id = p.id
      FROM commerce_paymentattempt p
     WHERE rf.brand_id = p_brand_id AND rf.payment_attempt_id IS NULL AND rf.payment_provider_id <> ''
       AND p.brand_id = rf.brand_id AND p.provider = rf.provider AND p.provider_id = rf.payment_provider_id;
    GET DIAGNOSTICS v_n = ROW_COUNT; v_refund_links := v_refund_links + v_n;

    UPDATE commerce_refund rf SET order_id = o.id
      FROM commerce_order o
     WHERE rf.brand_id = p_brand_id AND rf.order_id IS NULL AND rf.order_provider_id <> ''
       AND o.brand_id = rf.brand_id AND o.provider = 'shopify' AND o.provider_id = rf.order_provider_id;
    GET DIAGNOSTICS v_n = ROW_COUNT; v_refund_links := v_refund_links + v_n;

    UPDATE commerce_refund rf SET order_id = l.order_id
      FROM commerce_orderpaymentlink l
     WHERE rf.brand_id = p_brand_id AND rf.order_id IS NULL AND rf.payment_attempt_id = l.payment_attempt_id
       AND (SELECT count(*) FROM commerce_orderpaymentlink x WHERE x.payment_attempt_id = rf.payment_attempt_id) = 1;
    GET DIAGNOSTICS v_n = ROW_COUNT; v_refund_links := v_refund_links + v_n;

    INSERT INTO commerce_reconciliation AS r (workspace_id, brand_id, entity_type, entity_id, status, matched_order_id, match_method, confidence, details, updated_at)
    SELECT v_ws, p_brand_id, 'refund', rf.id,
           CASE WHEN p.id IS NOT NULL AND rf.amount_minor > p.amount_minor THEN 'NEEDS_REVIEW'
                WHEN rf.provider = 'razorpay' AND rf.payment_attempt_id IS NOT NULL AND rf.order_id IS NOT NULL THEN 'MATCHED'
                WHEN rf.provider = 'razorpay' AND rf.payment_attempt_id IS NOT NULL THEN 'PARTIALLY_MATCHED'
                WHEN rf.provider <> 'razorpay' AND rf.order_id IS NOT NULL THEN 'MATCHED'
                ELSE 'UNMATCHED' END,
           rf.order_id,
           CASE WHEN rf.provider = 'razorpay' THEN 'payment_id' ELSE 'order_id' END,
           CASE WHEN p.id IS NOT NULL AND rf.amount_minor > p.amount_minor THEN 0.50
                WHEN rf.order_id IS NOT NULL OR rf.payment_attempt_id IS NOT NULL THEN 1.00 ELSE 0 END,
           jsonb_strip_nulls(jsonb_build_object('amount_minor', rf.amount_minor, 'payment_found', rf.payment_attempt_id IS NOT NULL,
               'order_found', rf.order_id IS NOT NULL,
               'reason', CASE WHEN p.id IS NOT NULL AND rf.amount_minor > p.amount_minor THEN 'refund exceeds the payment amount'
                              WHEN rf.provider = 'razorpay' AND rf.payment_attempt_id IS NULL THEN 'refunded payment not ingested'
                              WHEN rf.order_id IS NULL THEN 'order for this refund not found' END)),
           v_now
      FROM commerce_refund rf
      LEFT JOIN commerce_paymentattempt p ON p.id = rf.payment_attempt_id
     WHERE rf.brand_id = p_brand_id
    ON CONFLICT (entity_type, entity_id) DO UPDATE
       SET status = EXCLUDED.status, matched_order_id = EXCLUDED.matched_order_id, match_method = EXCLUDED.match_method,
           confidence = EXCLUDED.confidence, details = EXCLUDED.details, updated_at = EXCLUDED.updated_at
     WHERE (r.status, r.matched_order_id, r.details) IS DISTINCT FROM (EXCLUDED.status, EXCLUDED.matched_order_id, EXCLUDED.details);

    -- (f) order lines -> product variants by platform variant id (exact)
    UPDATE commerce_orderline ol SET variant_id = v.id
      FROM commerce_order o, commerce_productvariant v
     WHERE ol.order_id = o.id AND o.brand_id = p_brand_id AND ol.variant_id IS NULL AND ol.provider_variant_id <> ''
       AND v.brand_id = o.brand_id AND v.provider = o.provider AND v.provider_id = ol.provider_variant_id;
    GET DIAGNOSTICS v_variants = ROW_COUNT;

    -- (g) attribution: GA4 transaction id = Shopify order id / number / name; UTM-only is partial
    INSERT INTO commerce_reconciliation AS r (workspace_id, brand_id, entity_type, entity_id, status, matched_order_id, match_method, confidence, details, updated_at)
    SELECT v_ws, p_brand_id, 'order_attribution', o.id,
           CASE WHEN g.n = 1 THEN 'MATCHED' WHEN g.n > 1 THEN 'NEEDS_REVIEW'
                WHEN o.utm_source IS NOT NULL THEN 'PARTIALLY_MATCHED' ELSE 'UNMATCHED' END,
           o.id,
           CASE WHEN g.n >= 1 THEN 'ga4_transaction_id' WHEN o.utm_source IS NOT NULL THEN 'order_utm' ELSE '' END,
           CASE WHEN g.n = 1 THEN 1.00 WHEN g.n > 1 THEN 0.40 WHEN o.utm_source IS NOT NULL THEN 0.70 ELSE 0 END,
           jsonb_strip_nulls(jsonb_build_object('ga4', g.attr, 'ga4_rows', g.n,
               'utm', CASE WHEN o.utm_source IS NOT NULL THEN jsonb_build_object('source', o.utm_source, 'medium', o.utm_medium, 'campaign', o.utm_campaign) END,
               'referring_domain', o.referring_domain)),
           v_now
      FROM commerce_order o
      LEFT JOIN LATERAL (
          SELECT count(*)::int AS n,
                 (array_agg(jsonb_build_object('source', t.session_source, 'medium', t.session_medium, 'campaign', t.session_campaign)))[1] AS attr
            FROM analytics_ga4_transaction t
           WHERE t.brand_id = o.brand_id AND t.transaction_id IN (o.provider_id, o.order_number, '#' || o.order_number)
          HAVING count(*) > 0) g ON true
     WHERE o.brand_id = p_brand_id AND o.provider = 'shopify'
    ON CONFLICT (entity_type, entity_id) DO UPDATE
       SET status = EXCLUDED.status, match_method = EXCLUDED.match_method,
           confidence = EXCLUDED.confidence, details = EXCLUDED.details, updated_at = EXCLUDED.updated_at
     WHERE (r.status, r.details) IS DISTINCT FROM (EXCLUDED.status, EXCLUDED.details);

    RETURN jsonb_build_object(
        'brand_id', p_brand_id,
        'new_payment_links', v_pay_links,
        'new_shipment_links', v_ship_links,
        'refund_links_set', v_refund_links,
        'orderlines_linked_to_variants', v_variants,
        'orderlines_without_variant', (SELECT count(*) FROM commerce_orderline ol JOIN commerce_order o ON o.id = ol.order_id
                                        WHERE o.brand_id = p_brand_id AND ol.variant_id IS NULL),
        'status', coalesce((SELECT jsonb_object_agg(entity_type, by_status) FROM (
                       SELECT entity_type, jsonb_object_agg(status, n) AS by_status FROM (
                           SELECT entity_type, status, count(*) AS n FROM commerce_reconciliation
                            WHERE brand_id = p_brand_id GROUP BY 1, 2) a GROUP BY 1) b), '{}'::jsonb));
END;
$$;
REVOKE ALL ON FUNCTION public.reconcile_brand(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_brand(UUID) TO service_role;

-- ─── 12. Data quality engine ────────────────────────────────────────────────────────────────
-- Records problems; never modifies or discards the offending data. Issues no longer found are
-- marked resolved (kept for history).
CREATE OR REPLACE FUNCTION public.run_data_quality_checks(p_brand_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_ws UUID;
    v_tz TEXT;
    v_now TIMESTAMPTZ := clock_timestamp();
    v_resolved INT;
BEGIN
    SELECT workspace_id, timezone INTO v_ws, v_tz FROM tenancy_brand WHERE id = p_brand_id;
    IF v_ws IS NULL THEN
        RAISE EXCEPTION 'run_data_quality_checks: unknown brand %', p_brand_id USING ERRCODE = '22023';
    END IF;

    INSERT INTO data_quality_issue AS d (workspace_id, brand_id, check_key, severity, entity_table, entity_id, message, details, first_seen_at, last_seen_at, resolved_at)
    SELECT v_ws, p_brand_id, f.check_key, f.severity, f.entity_table, f.entity_id, f.message, f.details, v_now, v_now, NULL
      FROM (
        -- required fields / ids
        SELECT 'order_missing_number' AS check_key, 'error' AS severity, 'commerce_order' AS entity_table, o.id AS entity_id,
               'Order has no order number' AS message, jsonb_build_object('provider_id', o.provider_id) AS details
          FROM commerce_order o WHERE o.brand_id = p_brand_id AND btrim(o.order_number) = ''
        UNION ALL
        SELECT 'order_missing_created_at', 'error', 'commerce_order', o.id, 'Order has no source creation timestamp', jsonb_build_object('order_number', o.order_number)
          FROM commerce_order o WHERE o.brand_id = p_brand_id AND o.source_created_at IS NULL
        UNION ALL
        SELECT 'payment_missing_created_at', 'error', 'commerce_paymentattempt', p.id, 'Payment has no source timestamp', jsonb_build_object('provider_id', p.provider_id)
          FROM commerce_paymentattempt p WHERE p.brand_id = p_brand_id AND p.source_created_at IS NULL
        UNION ALL
        SELECT 'captured_payment_zero_amount', 'warning', 'commerce_paymentattempt', p.id, 'Captured payment has a zero amount', jsonb_build_object('provider_id', p.provider_id)
          FROM commerce_paymentattempt p WHERE p.brand_id = p_brand_id AND p.status = 'captured' AND p.amount_minor = 0
        -- currency
        UNION ALL
        SELECT 'order_invalid_currency', 'error', 'commerce_order', o.id, 'Order currency is not an ISO-4217 code', jsonb_build_object('currency', o.currency)
          FROM commerce_order o WHERE o.brand_id = p_brand_id AND o.currency !~ '^[A-Z]{3}$'
        UNION ALL
        SELECT 'payment_invalid_currency', 'error', 'commerce_paymentattempt', p.id, 'Payment currency is not an ISO-4217 code', jsonb_build_object('currency', p.currency)
          FROM commerce_paymentattempt p WHERE p.brand_id = p_brand_id AND p.currency !~ '^[A-Z]{3}$'
        -- timestamps
        UNION ALL
        SELECT 'order_timestamp_out_of_range', 'error', 'commerce_order', o.id, 'Order timestamps are in the future, before 2000, or updated before created',
               jsonb_build_object('created', o.source_created_at, 'updated', o.source_updated_at)
          FROM commerce_order o
         WHERE o.brand_id = p_brand_id
           AND (o.source_created_at > v_now + INTERVAL '1 day' OR o.source_created_at < '2000-01-01'::timestamptz
                OR o.source_updated_at < o.source_created_at - INTERVAL '1 minute')
        -- amounts
        UNION ALL
        SELECT 'order_negative_net_sales', 'error', 'commerce_order', o.id, 'Net sales is negative', jsonb_build_object('net_sales', o.net_sales, 'gross_amount', o.gross_amount)
          FROM commerce_order o WHERE o.brand_id = p_brand_id AND o.net_sales < 0
        UNION ALL
        SELECT 'order_refund_exceeds_total', 'error', 'commerce_order', o.id, 'Refunded amount exceeds the order total', jsonb_build_object('refunded', o.refunded_amount, 'total', o.gross_amount)
          FROM commerce_order o WHERE o.brand_id = p_brand_id AND o.refunded_amount > o.gross_amount
        UNION ALL
        SELECT 'order_total_inconsistent', 'warning', 'commerce_order', o.id, 'Order total != subtotal + shipping (+ tax when not included)',
               jsonb_build_object('total', o.gross_amount, 'subtotal', o.subtotal_amount, 'shipping', o.shipping_amount, 'tax', o.tax_amount, 'taxes_included', o.taxes_included)
          FROM commerce_order o
         WHERE o.brand_id = p_brand_id AND o.subtotal_amount IS NOT NULL AND o.taxes_included IS NOT NULL
           AND abs(o.gross_amount - (o.subtotal_amount + o.shipping_amount + CASE WHEN o.taxes_included THEN 0 ELSE o.tax_amount END)) > 1
        UNION ALL
        SELECT 'payment_refund_exceeds_amount', 'error', 'commerce_paymentattempt', p.id, 'Refunded amount exceeds the payment amount', jsonb_build_object('refunded', p.refunded_amount_minor, 'amount', p.amount_minor)
          FROM commerce_paymentattempt p WHERE p.brand_id = p_brand_id AND p.refunded_amount_minor > p.amount_minor
        -- conflicting statuses
        UNION ALL
        SELECT 'order_refunded_without_refund_amount', 'warning', 'commerce_order', o.id, 'Order is marked refunded but no refund amount was recorded', jsonb_build_object('financial_status', o.financial_status)
          FROM commerce_order o WHERE o.brand_id = p_brand_id AND o.financial_status IN ('refunded', 'partially_refunded') AND o.refunded_amount = 0
        UNION ALL
        SELECT 'order_cancelled_but_paid', 'warning', 'commerce_order', o.id, 'Order is cancelled, marked paid, and has no refund', jsonb_build_object('cancelled_at', o.cancelled_at)
          FROM commerce_order o WHERE o.brand_id = p_brand_id AND o.cancelled_at IS NOT NULL AND o.financial_status = 'paid' AND coalesce(o.refunded_amount, 0) = 0
        UNION ALL
        SELECT 'order_cancelled_but_fulfilled', 'warning', 'commerce_order', o.id, 'Order is cancelled but fully fulfilled', jsonb_build_object('cancelled_at', o.cancelled_at)
          FROM commerce_order o WHERE o.brand_id = p_brand_id AND o.cancelled_at IS NOT NULL AND o.fulfillment_status = 'fulfilled'
        UNION ALL
        SELECT 'payment_unknown_source_status', 'warning', 'commerce_paymentattempt', p.id, 'Payment status from the platform is not a known value', jsonb_build_object('source_status', p.source_status, 'stored_as', p.status)
          FROM commerce_paymentattempt p WHERE p.brand_id = p_brand_id AND p.source_status <> '' AND p.source_status NOT IN ('created', 'authorized', 'captured', 'failed', 'refunded')
        UNION ALL
        SELECT 'shipment_unknown_status', 'warning', 'commerce_shipment', s.id, 'Courier status could not be mapped', jsonb_build_object('raw_status', s.raw_status)
          FROM commerce_shipment s WHERE s.brand_id = p_brand_id AND s.canonical_status = 'unknown'
        UNION ALL
        SELECT 'shipment_delivered_without_timestamp', 'warning', 'commerce_shipment', s.id, 'Shipment delivered but delivery time missing', jsonb_build_object('awb', s.awb)
          FROM commerce_shipment s WHERE s.brand_id = p_brand_id AND s.canonical_status = 'delivered' AND s.delivered_at IS NULL
        -- invalid / cross-tenant references (a FK that points into another brand)
        UNION ALL
        SELECT 'cross_brand_customer_reference', 'error', 'commerce_order', o.id, 'Order references a customer of another brand', jsonb_build_object('customer_id', o.customer_id)
          FROM commerce_order o JOIN commerce_customer c ON c.id = o.customer_id
         WHERE o.brand_id = p_brand_id AND c.brand_id <> o.brand_id
        UNION ALL
        SELECT 'cross_brand_payment_link', 'error', 'commerce_orderpaymentlink', l.id, 'Payment link joins records of different brands', jsonb_build_object('order_id', l.order_id, 'payment_id', l.payment_attempt_id)
          FROM commerce_orderpaymentlink l JOIN commerce_order o ON o.id = l.order_id JOIN commerce_paymentattempt p ON p.id = l.payment_attempt_id
         WHERE o.brand_id = p_brand_id AND p.brand_id <> o.brand_id
        UNION ALL
        SELECT 'cross_brand_shipment_link', 'error', 'commerce_ordershipmentlink', l.id, 'Shipment link joins records of different brands', jsonb_build_object('order_id', l.order_id, 'shipment_id', l.shipment_id)
          FROM commerce_ordershipmentlink l JOIN commerce_order o ON o.id = l.order_id JOIN commerce_shipment s ON s.id = l.shipment_id
         WHERE o.brand_id = p_brand_id AND s.brand_id <> o.brand_id
        UNION ALL
        SELECT 'cross_brand_variant_reference', 'error', 'commerce_orderline', ol.id, 'Order line references a variant of another brand', jsonb_build_object('variant_id', ol.variant_id)
          FROM commerce_orderline ol JOIN commerce_order o ON o.id = ol.order_id JOIN commerce_productvariant v ON v.id = ol.variant_id
         WHERE o.brand_id = p_brand_id AND v.brand_id <> o.brand_id
        -- orphans
        UNION ALL
        SELECT 'refund_orphaned', 'warning', 'commerce_refund', rf.id, 'Refund is linked to neither an order nor a payment', jsonb_build_object('provider', rf.provider, 'provider_id', rf.provider_id)
          FROM commerce_refund rf WHERE rf.brand_id = p_brand_id AND rf.order_id IS NULL AND rf.payment_attempt_id IS NULL
        -- duplicates (reported, never merged)
        UNION ALL
        SELECT 'customer_shared_email', 'info', 'commerce_customer', c.id, 'Several platform customers share this email; they are NOT merged automatically',
               jsonb_build_object('customers_with_same_email', x.n)
          FROM commerce_customer c
          JOIN (SELECT brand_id, email, count(*) AS n FROM commerce_customer WHERE brand_id = p_brand_id AND email <> '' GROUP BY 1, 2 HAVING count(*) > 1) x
            ON x.brand_id = c.brand_id AND x.email = c.email
        -- reconciliation mismatches
        UNION ALL
        SELECT 'payment_reconciliation_' || lower(r.status), CASE WHEN r.status = 'NEEDS_REVIEW' THEN 'warning' ELSE 'info' END,
               'commerce_paymentattempt', r.entity_id, coalesce(r.details ->> 'reason', 'Payment not reconciled'), r.details
          FROM commerce_reconciliation r JOIN commerce_paymentattempt p ON p.id = r.entity_id
         WHERE r.brand_id = p_brand_id AND r.entity_type = 'payment'
           AND (r.status = 'NEEDS_REVIEW' OR (r.status = 'UNMATCHED' AND p.status IN ('captured', 'refunded')))
        UNION ALL
        SELECT 'order_payment_' || lower(r.status), 'warning', 'commerce_order', r.entity_id, coalesce(r.details ->> 'reason', 'Order payment not reconciled'), r.details
          FROM commerce_reconciliation r
         WHERE r.brand_id = p_brand_id AND r.entity_type = 'order_payment' AND r.status <> 'MATCHED'
        UNION ALL
        SELECT 'shipment_' || lower(r.status), 'warning', 'commerce_shipment', r.entity_id, coalesce(r.details ->> 'reason', 'Shipment not reconciled'), r.details
          FROM commerce_reconciliation r
         WHERE r.brand_id = p_brand_id AND r.entity_type = 'shipment' AND r.status <> 'MATCHED'
        UNION ALL
        SELECT 'refund_source_mismatch', 'warning', 'commerce_order', o.id, 'Shopify refund total differs from Razorpay refunds on the linked payments',
               jsonb_build_object('shopify_refunded', o.refunded_amount, 'razorpay_refunded', rz.total)
          FROM commerce_order o
          JOIN LATERAL (SELECT sum(rf.amount_minor) AS total FROM commerce_refund rf
                         JOIN commerce_orderpaymentlink l ON l.payment_attempt_id = rf.payment_attempt_id
                        WHERE l.order_id = o.id AND rf.provider = 'razorpay' AND rf.status = 'processed') rz ON rz.total IS NOT NULL
         WHERE o.brand_id = p_brand_id AND o.refunded_amount IS NOT NULL AND o.refunded_amount <> rz.total
        -- ingestion failures
        UNION ALL
        SELECT 'raw_payload_processing_failed', 'error', 'integrations_rawpayload', rp.id, left('Normalisation failed: ' || rp.error, 500),
               jsonb_build_object('provider', rp.provider, 'topic', rp.topic, 'entity_id', rp.entity_id, 'attempts', rp.attempts)
          FROM integrations_rawpayload rp WHERE rp.brand_id = p_brand_id AND rp.processing_status = 'failed'
        -- aggregation: stored daily facts must equal a recomputation (same local-date rule)
        UNION ALL
        SELECT 'fact_shop_daily_mismatch', 'error', 'analytics_factshopdaily', f.id, 'Daily sales fact differs from the orders it summarises',
               jsonb_build_object('fact_date', f.fact_date, 'stored_orders', f.orders_count, 'actual_orders', coalesce(a.n, 0),
                                  'stored_net_sales', f.net_sales, 'actual_net_sales', coalesce(a.net, 0))
          FROM analytics_factshopdaily f
          LEFT JOIN LATERAL (SELECT count(*) AS n, sum(o.net_sales) AS net FROM commerce_order o
                              WHERE o.brand_id = f.brand_id AND o.financial_status <> 'voided'
                                AND (o.source_created_at AT TIME ZONE v_tz)::date = f.fact_date) a ON true
         WHERE f.brand_id = p_brand_id AND (f.orders_count <> coalesce(a.n, 0) OR f.net_sales <> coalesce(a.net, 0))
      ) f
    ON CONFLICT (brand_id, check_key, entity_table, entity_id) DO UPDATE
       SET severity = EXCLUDED.severity, message = EXCLUDED.message, details = EXCLUDED.details,
           last_seen_at = EXCLUDED.last_seen_at, resolved_at = NULL;

    UPDATE data_quality_issue SET resolved_at = v_now
     WHERE brand_id = p_brand_id AND resolved_at IS NULL AND last_seen_at < v_now;
    GET DIAGNOSTICS v_resolved = ROW_COUNT;

    RETURN jsonb_build_object(
        'brand_id', p_brand_id,
        'checked_at', v_now,
        'resolved_now', v_resolved,
        'open', coalesce((SELECT jsonb_object_agg(severity, n) FROM (
                    SELECT severity, count(*) AS n FROM data_quality_issue
                     WHERE brand_id = p_brand_id AND resolved_at IS NULL GROUP BY 1) s), '{}'::jsonb),
        'by_check', coalesce((SELECT jsonb_object_agg(check_key, n) FROM (
                    SELECT check_key, count(*) AS n FROM data_quality_issue
                     WHERE brand_id = p_brand_id AND resolved_at IS NULL GROUP BY 1) s), '{}'::jsonb));
END;
$$;
REVOKE ALL ON FUNCTION public.run_data_quality_checks(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_data_quality_checks(UUID) TO service_role;

-- Runs reconciliation then quality checks for every brand that has commerce data.
CREATE OR REPLACE FUNCTION public.run_data_pipeline_maintenance()
RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    b RECORD;
    n INT := 0;
BEGIN
    FOR b IN
        SELECT id FROM tenancy_brand t
         WHERE EXISTS (SELECT 1 FROM commerce_order o WHERE o.brand_id = t.id)
            OR EXISTS (SELECT 1 FROM commerce_paymentattempt p WHERE p.brand_id = t.id)
            OR EXISTS (SELECT 1 FROM commerce_shipment s WHERE s.brand_id = t.id)
    LOOP
        PERFORM public.reconcile_brand(b.id);
        PERFORM public.run_data_quality_checks(b.id);
        n := n + 1;
    END LOOP;
    RETURN n;
END;
$$;
REVOKE ALL ON FUNCTION public.run_data_pipeline_maintenance() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_data_pipeline_maintenance() TO service_role;

DO $outer$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
        PERFORM cron.schedule('data-pipeline-maintenance', '45 * * * *',
            $c$SELECT public.run_data_pipeline_maintenance()$c$);
    ELSE
        RAISE NOTICE 'pg_cron not installed: data-pipeline-maintenance not scheduled';
    END IF;
END
$outer$;
