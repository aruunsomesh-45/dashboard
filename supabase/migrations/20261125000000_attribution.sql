-- =====================================================================================
-- Phase 4: UTM attribution & customer journey.
--
-- Reuses Phase 3: commerce_order (UTM, landing path, referrer, gateway payment ref, cart token),
-- commerce_paymentattempt / commerce_refund / orderpaymentlink (verified money),
-- analytics_meta_ad_daily (platform-reported Meta numbers).
--
-- Order-level attribution already exists in production: the checkout app (Razorpay Magic Checkout)
-- writes utm_* / fbclid / rzp_3p_utm / rzp_device_id / cart_token into every order's note
-- attributes. This migration does NOT duplicate that capture; it adds what is missing:
-- visitors, sessions and journey events for people who did not buy (storefront pixel), campaign
-- links, channel classification, attribution models and revenue reporting.
--
-- Additive only. No existing table, column or row is changed or removed.
-- =====================================================================================

-- ─── 1. Tracking site: one per brand; the public key identifies the brand to the ingestion endpoint
CREATE TABLE IF NOT EXISTS public.attribution_site (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id      UUID NOT NULL REFERENCES public.tenancy_workspace(id) ON DELETE CASCADE,
    brand_id          UUID NOT NULL UNIQUE REFERENCES public.tenancy_brand(id) ON DELETE CASCADE,
    public_key        VARCHAR(40) NOT NULL UNIQUE,      -- embedded in the storefront pixel; an identifier, not a secret
    allowed_origins   TEXT[] NOT NULL DEFAULT '{}',     -- e.g. {https://125east.in}; empty = reject browser calls
    enabled           BOOLEAN NOT NULL DEFAULT true,
    session_timeout_minutes INTEGER NOT NULL DEFAULT 30 CHECK (session_timeout_minutes BETWEEN 5 AND 240),
    retention_days    INTEGER NULL CHECK (retention_days IS NULL OR retention_days >= 30),  -- NULL = keep
    created_at        TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT chk_attribution_site_key CHECK (public_key ~ '^pk_[A-Za-z0-9]{16,36}$')
);

-- ─── 2. Campaign links (generator). UTM fields are immutable once created = creation history.
CREATE TABLE IF NOT EXISTS public.attribution_link (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id     UUID NOT NULL REFERENCES public.tenancy_workspace(id) ON DELETE CASCADE,
    brand_id         UUID NOT NULL REFERENCES public.tenancy_brand(id) ON DELETE CASCADE,
    link_code        VARCHAR(16) NOT NULL,             -- sent as utm_id; identifies this exact link
    placement        VARCHAR(30) NOT NULL CHECK (placement IN ('instagram_bio', 'instagram_story', 'instagram_post',
                        'instagram_reel', 'meta_ads', 'google_ads', 'email', 'influencer', 'whatsapp', 'sms', 'custom')),
    destination_url  TEXT NOT NULL,
    final_url        TEXT NOT NULL,
    utm_source       VARCHAR(100) NOT NULL,
    utm_medium       VARCHAR(100) NOT NULL,
    utm_campaign     VARCHAR(150) NOT NULL,
    utm_content      VARCHAR(150) NULL,
    utm_term         VARCHAR(150) NULL,
    influencer_handle VARCHAR(100) NULL,
    label            VARCHAR(200) NOT NULL DEFAULT '',
    created_by       UUID NULL REFERENCES public.accounts_user(id) ON DELETE SET NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    archived_at      TIMESTAMPTZ NULL,
    CONSTRAINT uq_attribution_link_code UNIQUE (brand_id, link_code),
    CONSTRAINT chk_attribution_link_code CHECK (link_code ~ '^l_[a-z0-9]{8,12}$')
);
CREATE INDEX IF NOT EXISTS idx_attribution_link_brand ON public.attribution_link (brand_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.attribution_link_immutable()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
    IF (NEW.link_code, NEW.final_url, NEW.destination_url, NEW.utm_source, NEW.utm_medium, NEW.utm_campaign,
        NEW.utm_content, NEW.utm_term, NEW.brand_id, NEW.created_at)
       IS DISTINCT FROM
       (OLD.link_code, OLD.final_url, OLD.destination_url, OLD.utm_source, OLD.utm_medium, OLD.utm_campaign,
        OLD.utm_content, OLD.utm_term, OLD.brand_id, OLD.created_at) THEN
        RAISE EXCEPTION 'attribution_link: published links are immutable; create a new link instead' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_attribution_link_immutable ON public.attribution_link;
CREATE TRIGGER trg_attribution_link_immutable BEFORE UPDATE ON public.attribution_link
FOR EACH ROW EXECUTE FUNCTION public.attribution_link_immutable();

-- ─── 3. Channel rules (configurable; brand rules override the global defaults) ───────────
CREATE TABLE IF NOT EXISTS public.attribution_channel_rule (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    brand_id         UUID NULL REFERENCES public.tenancy_brand(id) ON DELETE CASCADE,  -- NULL = global default
    priority         INTEGER NOT NULL,
    channel          VARCHAR(40) NOT NULL,
    source_pattern   TEXT NULL,       -- case-insensitive regex; NULL = any
    medium_pattern   TEXT NULL,
    referrer_pattern TEXT NULL,
    requires_utm     BOOLEAN NULL,    -- true: utm_source present; false: absent; NULL: either
    requires_gclid   BOOLEAN NOT NULL DEFAULT false,
    description      TEXT NOT NULL DEFAULT '',
    CONSTRAINT uq_attribution_channel_rule UNIQUE NULLS NOT DISTINCT (brand_id, priority)
);

INSERT INTO public.attribution_channel_rule (brand_id, priority, channel, source_pattern, medium_pattern, referrer_pattern, requires_utm, requires_gclid, description) VALUES
 (NULL, 10, 'paid_meta',          '^[0-9]{12,}$', NULL, NULL, true, false, 'Meta dynamic URL parameters put the numeric campaign id in utm_source'),
 (NULL, 20, 'paid_meta',          '^(fb|facebook|ig|instagram|meta)$', '^(paid|cpc|ppc|paid_?social|ads?)$', NULL, true, false, 'explicit paid social'),
 (NULL, 25, 'paid_google',        NULL, NULL, NULL, NULL, true, 'Google Ads click id present'),
 (NULL, 30, 'paid_search',        NULL, '^(cpc|ppc|paid_?search|sem)$', NULL, true, false, 'paid search (other engines)'),
 (NULL, 40, 'influencer',         NULL, '(influencer|creator|collab|affiliate)', NULL, true, false, 'influencer / creator links'),
 (NULL, 50, 'organic_instagram',  '^(ig|instagram)$', NULL, NULL, true, false, 'Instagram bio / story / post links'),
 (NULL, 55, 'organic_facebook',   '^(fb|facebook)$', NULL, NULL, true, false, 'Facebook organic links'),
 (NULL, 60, 'whatsapp',           '(whatsapp|^wa$|bitespeed)', NULL, NULL, true, false, 'WhatsApp campaigns'),
 (NULL, 61, 'whatsapp',           NULL, '(whatsapp|^wa$)', NULL, true, false, 'WhatsApp by medium'),
 (NULL, 65, 'email',              '(email|newsletter|klaviyo|mailchimp)', NULL, NULL, true, false, 'email'),
 (NULL, 66, 'email',              NULL, '(email|newsletter)', NULL, true, false, 'email by medium'),
 (NULL, 70, 'organic_search',     '^(google|bing|yahoo|duckduckgo)$', '^(organic|seo|)$', NULL, true, false, 'search engines, organic'),
 (NULL, 80, 'other_campaign',     NULL, NULL, NULL, true, false, 'any other tagged link'),
 (NULL, 90, 'organic_instagram',  NULL, NULL, '(^|\.)instagram\.com$', false, false, 'untagged Instagram referral'),
 (NULL, 91, 'organic_facebook',   NULL, NULL, '(^|\.)(facebook\.com|fb\.com|fb\.me)$', false, false, 'untagged Facebook referral'),
 (NULL, 92, 'organic_search',     NULL, NULL, '(^|\.)(google\.[a-z.]+|bing\.com|duckduckgo\.com|search\.yahoo\.com)$', false, false, 'untagged search referral'),
 (NULL, 95, 'referral',           NULL, NULL, '.+', false, false, 'other external referrer'),
 (NULL, 99, 'direct',             NULL, NULL, NULL, false, false, 'no campaign, no referrer')
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION public.attribution_classify_channel(
    p_brand_id UUID, p_source TEXT, p_medium TEXT, p_referrer_domain TEXT, p_has_gclid BOOLEAN)
RETURNS TEXT
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
    SELECT coalesce((
        SELECT r.channel FROM attribution_channel_rule r
         WHERE (r.brand_id = p_brand_id OR r.brand_id IS NULL)
           AND (r.requires_utm IS NULL OR r.requires_utm = (coalesce(p_source, '') <> ''))
           AND (NOT r.requires_gclid OR coalesce(p_has_gclid, false))
           AND (r.source_pattern IS NULL OR coalesce(p_source, '') ~* r.source_pattern)
           AND (r.medium_pattern IS NULL OR coalesce(p_medium, '') ~* r.medium_pattern)
           AND (r.referrer_pattern IS NULL OR coalesce(p_referrer_domain, '') ~* r.referrer_pattern)
         ORDER BY (r.brand_id IS NULL), r.priority
         LIMIT 1), 'direct');
$$;

-- ─── 4. Visitors, sessions, events (first-party, consented storefront pixel) ─────────────
CREATE TABLE IF NOT EXISTS public.attribution_visitor (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id   UUID NOT NULL REFERENCES public.tenancy_workspace(id) ON DELETE CASCADE,
    brand_id       UUID NOT NULL REFERENCES public.tenancy_brand(id) ON DELETE CASCADE,
    visitor_key    VARCHAR(64) NOT NULL,        -- random first-party id; never derived from the device
    first_seen_at  TIMESTAMPTZ NOT NULL,
    last_seen_at   TIMESTAMPTZ NOT NULL,
    sessions_count INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT uq_attribution_visitor UNIQUE (brand_id, visitor_key)
);

CREATE TABLE IF NOT EXISTS public.attribution_session (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id    UUID NOT NULL REFERENCES public.tenancy_workspace(id) ON DELETE CASCADE,
    brand_id        UUID NOT NULL REFERENCES public.tenancy_brand(id) ON DELETE CASCADE,
    visitor_id      UUID NOT NULL REFERENCES public.attribution_visitor(id) ON DELETE CASCADE,
    session_key     VARCHAR(64) NOT NULL,
    session_number  INTEGER NOT NULL DEFAULT 1,          -- 1 = first visit; > 1 = returning visitor
    started_at      TIMESTAMPTZ NOT NULL,
    last_event_at   TIMESTAMPTZ NOT NULL,
    landing_path    VARCHAR(500) NOT NULL DEFAULT '/',
    exit_path       VARCHAR(500) NULL,
    referrer_domain VARCHAR(255) NULL,
    utm_source      VARCHAR(255) NULL,
    utm_medium      VARCHAR(255) NULL,
    utm_campaign    VARCHAR(255) NULL,
    utm_content     VARCHAR(255) NULL,
    utm_term        VARCHAR(255) NULL,
    utm_id          VARCHAR(255) NULL,
    click_ids       JSONB NOT NULL DEFAULT '{}'::jsonb,  -- fbclid / gclid / wbraid / gbraid / ttclid as received
    device_category VARCHAR(20) NULL,
    browser_family  VARCHAR(30) NULL,
    CONSTRAINT uq_attribution_session UNIQUE (brand_id, session_key)
);
CREATE INDEX IF NOT EXISTS idx_attribution_session_brand_started ON public.attribution_session (brand_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_attribution_session_visitor ON public.attribution_session (visitor_id, started_at);

CREATE TABLE IF NOT EXISTS public.attribution_event (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id     UUID NOT NULL REFERENCES public.tenancy_workspace(id) ON DELETE CASCADE,
    brand_id         UUID NOT NULL REFERENCES public.tenancy_brand(id) ON DELETE CASCADE,
    event_id         VARCHAR(80) NOT NULL,       -- client UUID, or deterministic srv:* id for server events
    event_name       VARCHAR(40) NOT NULL CHECK (event_name IN ('page_view', 'landing_page_view', 'product_view',
                        'add_to_cart', 'begin_checkout', 'checkout_completed', 'purchase', 'payment_success',
                        'payment_failed', 'refund', 'customer_return')),
    source           VARCHAR(10) NOT NULL CHECK (source IN ('pixel', 'server')),
    visitor_id       UUID NULL REFERENCES public.attribution_visitor(id) ON DELETE CASCADE,
    session_id       UUID NULL REFERENCES public.attribution_session(id) ON DELETE CASCADE,
    occurred_at      TIMESTAMPTZ NOT NULL,
    received_at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    seq              INTEGER NULL,                -- client sequence within the session (event order)
    page_path        VARCHAR(500) NULL,
    product_ref      VARCHAR(100) NULL,
    cart_token       VARCHAR(100) NULL,
    order_ref        VARCHAR(100) NULL,
    payment_ref      VARCHAR(100) NULL,
    value_minor      BIGINT NULL,                 -- browser-claimed value: informational, NEVER revenue
    currency         VARCHAR(3) NULL,
    processing_status VARCHAR(12) NOT NULL DEFAULT 'accepted' CHECK (processing_status IN ('accepted', 'linked', 'rejected')),
    CONSTRAINT uq_attribution_event UNIQUE (brand_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_attribution_event_session ON public.attribution_event (session_id, occurred_at, seq);
CREATE INDEX IF NOT EXISTS idx_attribution_event_brand_time ON public.attribution_event (brand_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_attribution_event_cart ON public.attribution_event (brand_id, cart_token) WHERE cart_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_attribution_event_order ON public.attribution_event (brand_id, order_ref) WHERE order_ref IS NOT NULL;

-- ─── 5. Touchpoints: every marketing touch from any source, classified once ──────────────
CREATE TABLE IF NOT EXISTS public.attribution_touchpoint (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id         UUID NOT NULL REFERENCES public.tenancy_workspace(id) ON DELETE CASCADE,
    brand_id             UUID NOT NULL REFERENCES public.tenancy_brand(id) ON DELETE CASCADE,
    touch_type           VARCHAR(20) NOT NULL CHECK (touch_type IN ('session', 'checkout_capture', 'storefront_landing')),
    visitor_id           UUID NULL REFERENCES public.attribution_visitor(id) ON DELETE CASCADE,
    session_id           UUID NULL REFERENCES public.attribution_session(id) ON DELETE CASCADE,
    order_id             UUID NULL REFERENCES public.commerce_order(id) ON DELETE CASCADE,
    occurred_at          TIMESTAMPTZ NOT NULL,
    utm_source           VARCHAR(255) NULL,
    utm_medium           VARCHAR(255) NULL,
    utm_campaign         VARCHAR(255) NULL,
    utm_content          VARCHAR(255) NULL,
    utm_term             VARCHAR(255) NULL,
    utm_id               VARCHAR(255) NULL,
    has_fbclid           BOOLEAN NOT NULL DEFAULT false,
    has_gclid            BOOLEAN NOT NULL DEFAULT false,
    landing_path         VARCHAR(500) NULL,
    referrer_domain      VARCHAR(255) NULL,
    device_ref           VARCHAR(150) NULL,        -- checkout app device id (e.g. rzp_device_id)
    device_first_seen_at TIMESTAMPTZ NULL,
    -- derived by trigger (single source of truth: attribution_channel_rule)
    channel              VARCHAR(40) NOT NULL DEFAULT 'direct',
    is_direct            BOOLEAN NOT NULL DEFAULT true,
    link_id              UUID NULL REFERENCES public.attribution_link(id) ON DELETE SET NULL,
    meta_campaign_id     VARCHAR(30) NULL,
    meta_adset_id        VARCHAR(30) NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT chk_touchpoint_anchor CHECK (session_id IS NOT NULL OR order_id IS NOT NULL)
);
-- Plain (not partial) unique constraints so PostgREST upserts can target them; NULLs never conflict.
ALTER TABLE public.attribution_touchpoint ADD CONSTRAINT uq_touchpoint_session UNIQUE (session_id);
ALTER TABLE public.attribution_touchpoint ADD CONSTRAINT uq_touchpoint_order_type UNIQUE (order_id, touch_type);
CREATE INDEX IF NOT EXISTS idx_touchpoint_visitor ON public.attribution_touchpoint (visitor_id, occurred_at) WHERE visitor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_touchpoint_brand_time ON public.attribution_touchpoint (brand_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_touchpoint_meta ON public.attribution_touchpoint (brand_id, meta_campaign_id) WHERE meta_campaign_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.attribution_touchpoint_derive()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
    NEW.channel := attribution_classify_channel(NEW.brand_id, NEW.utm_source, NEW.utm_medium, NEW.referrer_domain, NEW.has_gclid);
    NEW.is_direct := NEW.channel = 'direct';
    -- Meta dynamic parameters (verified 2026-11-23 against the live ad account):
    --   utm_source = campaign id, utm_term = ad set id.
    NEW.meta_campaign_id := CASE WHEN NEW.channel = 'paid_meta' AND NEW.utm_source ~ '^[0-9]{12,25}$' THEN NEW.utm_source END;
    NEW.meta_adset_id    := CASE WHEN NEW.channel = 'paid_meta' AND NEW.utm_term ~ '^[0-9]{12,25}$' THEN NEW.utm_term END;
    NEW.link_id := (SELECT l.id FROM attribution_link l WHERE l.brand_id = NEW.brand_id AND l.link_code = NEW.utm_id);
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_attribution_touchpoint_derive ON public.attribution_touchpoint;
CREATE TRIGGER trg_attribution_touchpoint_derive BEFORE INSERT OR UPDATE ON public.attribution_touchpoint
FOR EACH ROW EXECUTE FUNCTION public.attribution_touchpoint_derive();

-- ─── 6. Conversions: verified Shopify orders, linked to a visitor only by hard evidence ──
CREATE TABLE IF NOT EXISTS public.attribution_conversion (
    order_id      UUID PRIMARY KEY REFERENCES public.commerce_order(id) ON DELETE CASCADE,
    workspace_id  UUID NOT NULL REFERENCES public.tenancy_workspace(id) ON DELETE CASCADE,
    brand_id      UUID NOT NULL REFERENCES public.tenancy_brand(id) ON DELETE CASCADE,
    converted_at  TIMESTAMPTZ NOT NULL,
    visitor_id    UUID NULL REFERENCES public.attribution_visitor(id) ON DELETE SET NULL,
    session_id    UUID NULL REFERENCES public.attribution_session(id) ON DELETE SET NULL,
    link_method   VARCHAR(20) NOT NULL CHECK (link_method IN ('cart_token', 'checkout_event', 'ambiguous', 'none')),
    linked_at     TIMESTAMPTZ NULL,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_attribution_conversion_brand ON public.attribution_conversion (brand_id, converted_at DESC);
CREATE INDEX IF NOT EXISTS idx_attribution_conversion_visitor ON public.attribution_conversion (visitor_id) WHERE visitor_id IS NOT NULL;

-- ─── 7. Models (versioned, immutable), per-brand default, results ───────────────────────
CREATE TABLE IF NOT EXISTS public.attribution_model (
    model_key   VARCHAR(30) NOT NULL CHECK (model_key IN ('first_touch', 'last_touch', 'last_non_direct', 'linear', 'assisted')),
    version     INTEGER NOT NULL CHECK (version >= 1),
    params      JSONB NOT NULL,                 -- {"lookback_days":30,"dedupe_minutes":30}
    description TEXT NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (model_key, version)
);
INSERT INTO public.attribution_model (model_key, version, params, description) VALUES
 ('first_touch',     1, '{"lookback_days":30,"dedupe_minutes":30}', 'Earliest touch in the lookback window (direct counts only if it is the only touch)'),
 ('last_touch',      1, '{"lookback_days":30,"dedupe_minutes":30}', 'Last touch before the order, direct included'),
 ('last_non_direct', 1, '{"lookback_days":30,"dedupe_minutes":30}', 'Last non-direct touch; direct only when nothing else exists'),
 ('linear',          1, '{"lookback_days":30,"dedupe_minutes":30}', 'Equal credit to every distinct touch in the window'),
 ('assisted',        1, '{"lookback_days":30,"dedupe_minutes":30}', 'Touches that contributed but did not get last-non-direct credit (credit 0)')
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION public.attribution_model_immutable()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'attribution_model: versions are immutable; insert a new version' USING ERRCODE = '42501';
END $$;
DROP TRIGGER IF EXISTS trg_attribution_model_immutable ON public.attribution_model;
CREATE TRIGGER trg_attribution_model_immutable BEFORE UPDATE OR DELETE ON public.attribution_model
FOR EACH ROW EXECUTE FUNCTION public.attribution_model_immutable();

CREATE TABLE IF NOT EXISTS public.attribution_settings (
    brand_id        UUID PRIMARY KEY REFERENCES public.tenancy_brand(id) ON DELETE CASCADE,
    workspace_id    UUID NOT NULL REFERENCES public.tenancy_workspace(id) ON DELETE CASCADE,
    default_model   VARCHAR(30) NOT NULL DEFAULT 'last_non_direct',
    default_version INTEGER NOT NULL DEFAULT 1,
    changed_at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    changed_by      UUID NULL REFERENCES public.accounts_user(id) ON DELETE SET NULL,
    FOREIGN KEY (default_model, default_version) REFERENCES public.attribution_model(model_key, version)
);

CREATE TABLE IF NOT EXISTS public.attribution_result (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id   UUID NOT NULL REFERENCES public.tenancy_workspace(id) ON DELETE CASCADE,
    brand_id       UUID NOT NULL REFERENCES public.tenancy_brand(id) ON DELETE CASCADE,
    order_id       UUID NOT NULL REFERENCES public.commerce_order(id) ON DELETE CASCADE,
    model_key      VARCHAR(30) NOT NULL,
    model_version  INTEGER NOT NULL,
    touchpoint_id  UUID NULL REFERENCES public.attribution_touchpoint(id) ON DELETE CASCADE,  -- NULL = unattributed
    role           VARCHAR(10) NOT NULL CHECK (role IN ('converting', 'assist')),
    credit         NUMERIC(9, 6) NOT NULL CHECK (credit >= 0 AND credit <= 1),
    touches_in_window INTEGER NOT NULL,
    computed_at    TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (model_key, model_version) REFERENCES public.attribution_model(model_key, version),
    CONSTRAINT uq_attribution_result UNIQUE NULLS NOT DISTINCT (order_id, model_key, model_version, touchpoint_id)
);
CREATE INDEX IF NOT EXISTS idx_attribution_result_brand ON public.attribution_result (brand_id, model_key, model_version);
CREATE INDEX IF NOT EXISTS idx_attribution_result_touch ON public.attribution_result (touchpoint_id);

-- ─── 8. Ingestion (called by the `track` Edge Function with a validated, normalised batch) ──
CREATE OR REPLACE FUNCTION public.ingest_tracking_batch(p_public_key TEXT, p_origin TEXT, p_batch JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_site attribution_site%ROWTYPE;
    v_visitor UUID;
    v_visitor_sessions INT;
    v_session UUID;
    v_session_new BOOLEAN;
    v_s JSONB := p_batch -> 'session';
    v_now TIMESTAMPTZ := clock_timestamp();
    v_started TIMESTAMPTZ;
    v_accepted INT := 0;
    v_total INT := coalesce(jsonb_array_length(p_batch -> 'events'), 0);
    v_last_path TEXT;
    v_last_at TIMESTAMPTZ;
BEGIN
    SELECT * INTO v_site FROM attribution_site WHERE public_key = p_public_key AND enabled;
    IF NOT FOUND THEN RAISE EXCEPTION 'unknown or disabled site' USING ERRCODE = '28000'; END IF;
    IF NOT (p_origin = ANY (v_site.allowed_origins)) THEN RAISE EXCEPTION 'origin not allowed' USING ERRCODE = '28000'; END IF;
    IF coalesce((p_batch -> 'consent' ->> 'analytics')::boolean, false) IS NOT TRUE THEN
        RETURN jsonb_build_object('accepted', 0, 'duplicates', 0, 'stored', false, 'reason', 'no analytics consent');
    END IF;

    v_started := coalesce((v_s ->> 'started_at')::timestamptz, v_now);

    INSERT INTO attribution_visitor AS v (workspace_id, brand_id, visitor_key, first_seen_at, last_seen_at)
    VALUES (v_site.workspace_id, v_site.brand_id, p_batch -> 'visitor' ->> 'key', v_started, v_now)
    ON CONFLICT (brand_id, visitor_key) DO UPDATE SET last_seen_at = greatest(v.last_seen_at, EXCLUDED.last_seen_at)
    RETURNING v.id, v.sessions_count INTO v_visitor, v_visitor_sessions;

    -- Attribution fields are written only when the session is created, never overwritten afterwards.
    INSERT INTO attribution_session AS s (workspace_id, brand_id, visitor_id, session_key, session_number, started_at, last_event_at,
        landing_path, referrer_domain, utm_source, utm_medium, utm_campaign, utm_content, utm_term, utm_id, click_ids,
        device_category, browser_family)
    VALUES (v_site.workspace_id, v_site.brand_id, v_visitor, v_s ->> 'key', v_visitor_sessions + 1, v_started, v_started,
        coalesce(v_s ->> 'landing_path', '/'), v_s ->> 'referrer_domain',
        v_s -> 'utm' ->> 'source', v_s -> 'utm' ->> 'medium', v_s -> 'utm' ->> 'campaign',
        v_s -> 'utm' ->> 'content', v_s -> 'utm' ->> 'term', v_s -> 'utm' ->> 'id',
        coalesce(v_s -> 'click_ids', '{}'::jsonb), v_s ->> 'device_category', v_s ->> 'browser_family')
    ON CONFLICT (brand_id, session_key) DO NOTHING
    RETURNING s.id INTO v_session;
    v_session_new := v_session IS NOT NULL;

    IF v_session_new THEN
        UPDATE attribution_visitor SET sessions_count = sessions_count + 1 WHERE id = v_visitor;
        INSERT INTO attribution_touchpoint (workspace_id, brand_id, touch_type, visitor_id, session_id, occurred_at,
            utm_source, utm_medium, utm_campaign, utm_content, utm_term, utm_id, has_fbclid, has_gclid, landing_path, referrer_domain)
        SELECT s.workspace_id, s.brand_id, 'session', s.visitor_id, s.id, s.started_at,
               s.utm_source, s.utm_medium, s.utm_campaign, s.utm_content, s.utm_term, s.utm_id,
               s.click_ids ? 'fbclid', (s.click_ids ? 'gclid' OR s.click_ids ? 'gbraid' OR s.click_ids ? 'wbraid'),
               s.landing_path, s.referrer_domain
          FROM attribution_session s WHERE s.id = v_session;
        IF v_visitor_sessions > 0 THEN
            INSERT INTO attribution_event (workspace_id, brand_id, event_id, event_name, source, visitor_id, session_id, occurred_at, page_path)
            VALUES (v_site.workspace_id, v_site.brand_id, 'srv:return:' || v_session, 'customer_return', 'server', v_visitor, v_session,
                    v_started, coalesce(v_s ->> 'landing_path', '/'))
            ON CONFLICT DO NOTHING;
        END IF;
    ELSE
        SELECT s.id INTO v_session FROM attribution_session s WHERE s.brand_id = v_site.brand_id AND s.session_key = v_s ->> 'key';
        IF (SELECT visitor_id FROM attribution_session WHERE id = v_session) <> v_visitor THEN
            RAISE EXCEPTION 'session belongs to another visitor' USING ERRCODE = '22023';  -- never merge visitors
        END IF;
    END IF;

    WITH ins AS (
        INSERT INTO attribution_event (workspace_id, brand_id, event_id, event_name, source, visitor_id, session_id, occurred_at, seq,
            page_path, product_ref, cart_token, order_ref, value_minor, currency)
        SELECT v_site.workspace_id, v_site.brand_id, e ->> 'id', e ->> 'name', 'pixel', v_visitor, v_session,
               (e ->> 'ts')::timestamptz, (e ->> 'seq')::int, e ->> 'path', e ->> 'product_ref', e ->> 'cart_token',
               e ->> 'order_ref', (e ->> 'value_minor')::bigint, e ->> 'currency'
          FROM jsonb_array_elements(coalesce(p_batch -> 'events', '[]'::jsonb)) e
        ON CONFLICT (brand_id, event_id) DO NOTHING
        RETURNING occurred_at, page_path)
    SELECT count(*), max(occurred_at), (array_agg(page_path ORDER BY occurred_at DESC))[1]
      INTO v_accepted, v_last_at, v_last_path FROM ins;

    IF v_last_at IS NOT NULL THEN
        UPDATE attribution_session
           SET last_event_at = greatest(last_event_at, v_last_at),
               exit_path = CASE WHEN v_last_at >= last_event_at THEN coalesce(v_last_path, exit_path) ELSE exit_path END
         WHERE id = v_session;
    END IF;

    RETURN jsonb_build_object('accepted', v_accepted, 'duplicates', v_total - v_accepted, 'stored', true,
                              'new_session', v_session_new, 'returning_visitor', v_visitor_sessions > 0);
END;
$$;
REVOKE ALL ON FUNCTION public.ingest_tracking_batch(TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ingest_tracking_batch(TEXT, TEXT, JSONB) TO service_role;

-- ─── 9. Visitor -> order linking (hard evidence only) + server-side journey events ─────────
CREATE OR REPLACE FUNCTION public.link_attribution_conversions(p_brand_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_ws UUID;
    v_n INT;
BEGIN
    SELECT workspace_id INTO v_ws FROM tenancy_brand WHERE id = p_brand_id;
    IF v_ws IS NULL THEN RAISE EXCEPTION 'unknown brand' USING ERRCODE = '22023'; END IF;

    WITH ev AS (
        -- evidence 1: pixel checkout_completed carrying the Shopify order id (native checkout)
        SELECT o.id AS order_id, e.visitor_id, e.session_id, e.occurred_at, 'checkout_event' AS method
          FROM commerce_order o JOIN attribution_event e
            ON e.brand_id = o.brand_id AND e.event_name = 'checkout_completed' AND e.order_ref = o.provider_id
         WHERE o.brand_id = p_brand_id AND e.visitor_id IS NOT NULL
        UNION ALL
        -- evidence 2: the cart the visitor built is the cart the checkout app turned into the order
        SELECT o.id, e.visitor_id, e.session_id, e.occurred_at, 'cart_token'
          FROM commerce_order o JOIN attribution_event e
            ON e.brand_id = o.brand_id AND e.cart_token = o.checkout_cart_token
         WHERE o.brand_id = p_brand_id AND o.checkout_cart_token <> '' AND e.visitor_id IS NOT NULL
           AND e.occurred_at <= o.source_created_at + INTERVAL '10 minutes'
    ), per_order AS (
        SELECT order_id, count(DISTINCT visitor_id) AS visitors,
               (array_agg(visitor_id ORDER BY occurred_at DESC))[1] AS visitor_id,
               (array_agg(session_id ORDER BY occurred_at DESC))[1] AS session_id,
               (array_agg(method ORDER BY (method = 'checkout_event') DESC, occurred_at DESC))[1] AS method
          FROM ev GROUP BY order_id
    )
    INSERT INTO attribution_conversion AS c (order_id, workspace_id, brand_id, converted_at, visitor_id, session_id, link_method, linked_at)
    SELECT o.id, o.workspace_id, o.brand_id, coalesce(o.source_created_at, o.created_at),
           CASE WHEN p.visitors = 1 THEN p.visitor_id END,
           CASE WHEN p.visitors = 1 THEN p.session_id END,
           CASE WHEN p.visitors = 1 THEN p.method WHEN p.visitors > 1 THEN 'ambiguous' ELSE 'none' END,
           CASE WHEN p.visitors = 1 THEN clock_timestamp() END
      FROM commerce_order o LEFT JOIN per_order p ON p.order_id = o.id
     WHERE o.brand_id = p_brand_id AND o.provider = 'shopify'
    ON CONFLICT (order_id) DO UPDATE
       SET visitor_id = EXCLUDED.visitor_id, session_id = EXCLUDED.session_id, link_method = EXCLUDED.link_method,
           linked_at = EXCLUDED.linked_at, converted_at = EXCLUDED.converted_at, updated_at = clock_timestamp()
     -- an established link is never replaced; unlinked/ambiguous rows may be upgraded by new evidence
     WHERE c.visitor_id IS NULL AND (c.link_method, c.visitor_id) IS DISTINCT FROM (EXCLUDED.link_method, EXCLUDED.visitor_id);
    GET DIAGNOSTICS v_n = ROW_COUNT;

    UPDATE attribution_event e SET processing_status = 'linked'
      FROM attribution_conversion c
     WHERE c.brand_id = p_brand_id AND e.brand_id = c.brand_id AND e.session_id = c.session_id AND e.processing_status = 'accepted';

    -- Server-side journey events from VERIFIED records (deterministic ids => idempotent).
    INSERT INTO attribution_event (workspace_id, brand_id, event_id, event_name, source, visitor_id, session_id, occurred_at, order_ref)
    SELECT c.workspace_id, c.brand_id, 'srv:order:' || o.id, 'purchase', 'server', c.visitor_id, c.session_id, c.converted_at, o.provider_id
      FROM attribution_conversion c JOIN commerce_order o ON o.id = c.order_id
     WHERE c.brand_id = p_brand_id
    ON CONFLICT DO NOTHING;

    INSERT INTO attribution_event (workspace_id, brand_id, event_id, event_name, source, visitor_id, session_id, occurred_at, order_ref, payment_ref)
    SELECT c.workspace_id, c.brand_id, 'srv:pay:' || p.id || ':' || p.status,
           CASE WHEN p.status = 'failed' THEN 'payment_failed' ELSE 'payment_success' END,
           'server', c.visitor_id, c.session_id, coalesce(p.source_created_at, c.converted_at), o.provider_id, p.provider_id
      FROM attribution_conversion c
      JOIN commerce_order o ON o.id = c.order_id
      JOIN commerce_orderpaymentlink l ON l.order_id = o.id
      JOIN commerce_paymentattempt p ON p.id = l.payment_attempt_id
     WHERE c.brand_id = p_brand_id AND p.status IN ('captured', 'refunded', 'failed')
    ON CONFLICT DO NOTHING;

    INSERT INTO attribution_event (workspace_id, brand_id, event_id, event_name, source, visitor_id, session_id, occurred_at, order_ref)
    SELECT c.workspace_id, c.brand_id, 'srv:refund:' || rf.id, 'refund', 'server', c.visitor_id, c.session_id,
           coalesce(rf.source_created_at, rf.created_at), o.provider_id
      FROM attribution_conversion c JOIN commerce_order o ON o.id = c.order_id
      JOIN commerce_refund rf ON rf.order_id = o.id AND rf.status = 'processed'
     WHERE c.brand_id = p_brand_id
    ON CONFLICT DO NOTHING;

    RETURN jsonb_build_object('conversions_changed', v_n,
        'by_method', (SELECT coalesce(jsonb_object_agg(link_method, n), '{}'::jsonb)
                        FROM (SELECT link_method, count(*) n FROM attribution_conversion WHERE brand_id = p_brand_id GROUP BY 1) x));
END;
$$;
REVOKE ALL ON FUNCTION public.link_attribution_conversions(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.link_attribution_conversions(UUID) TO service_role;

-- ─── 10. Attribution engine ─────────────────────────────────────────────────────────────────
-- Touches for an order = order-level touches (checkout capture, storefront landing) + touches of the
-- visitor it is linked to, inside the model's lookback window, before the order (+5 min tolerance
-- because checkout capture is stamped during checkout). Identical touches within dedupe_minutes
-- are collapsed (the pixel session and the checkout app often record the same click).
CREATE OR REPLACE FUNCTION public.compute_attribution(p_brand_id UUID, p_model TEXT, p_version INT, p_since TIMESTAMPTZ DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_params JSONB;
    v_lookback INT;
    v_dedupe INT;
    v_orders INT;
    v_rows INT;
BEGIN
    SELECT params INTO v_params FROM attribution_model WHERE model_key = p_model AND version = p_version;
    IF v_params IS NULL THEN RAISE EXCEPTION 'unknown attribution model %/%', p_model, p_version USING ERRCODE = '22023'; END IF;
    v_lookback := (v_params ->> 'lookback_days')::int;
    v_dedupe := (v_params ->> 'dedupe_minutes')::int;

    DROP TABLE IF EXISTS _attr_orders;
    CREATE TEMP TABLE _attr_orders ON COMMIT DROP AS
    SELECT c.order_id, c.workspace_id, c.brand_id, c.visitor_id, c.converted_at
      FROM attribution_conversion c JOIN commerce_order o ON o.id = c.order_id
     WHERE c.brand_id = p_brand_id AND o.financial_status <> 'voided'
       AND (p_since IS NULL OR c.converted_at >= p_since OR o.updated_at >= p_since);
    GET DIAGNOSTICS v_orders = ROW_COUNT;

    DROP TABLE IF EXISTS _attr_touches;
    CREATE TEMP TABLE _attr_touches ON COMMIT DROP AS
    WITH raw AS (
        SELECT DISTINCT a.order_id, t.id AS touchpoint_id, t.occurred_at, t.is_direct, t.touch_type,
               concat_ws('|', t.channel, lower(t.utm_source), lower(t.utm_medium), lower(t.utm_campaign), lower(t.utm_content), t.referrer_domain) AS identity
          FROM _attr_orders a
          JOIN attribution_touchpoint t ON t.brand_id = a.brand_id
           AND (t.order_id = a.order_id OR (a.visitor_id IS NOT NULL AND t.visitor_id = a.visitor_id))
         WHERE t.occurred_at <= a.converted_at + INTERVAL '5 minutes'
           AND t.occurred_at >= a.converted_at - make_interval(days => v_lookback)
    ), flagged AS (
        SELECT r.*, lag(r.occurred_at) OVER (PARTITION BY r.order_id, r.identity ORDER BY r.occurred_at, (r.touch_type = 'session') DESC) AS prev_same
          FROM raw r
    )
    SELECT order_id, touchpoint_id, occurred_at, is_direct,
           row_number() OVER (PARTITION BY order_id ORDER BY occurred_at, touchpoint_id) AS rn_first,
           row_number() OVER (PARTITION BY order_id ORDER BY occurred_at DESC, touchpoint_id DESC) AS rn_last,
           row_number() OVER (PARTITION BY order_id ORDER BY (NOT is_direct) DESC, occurred_at DESC, touchpoint_id DESC) AS rn_last_non_direct,
           count(*) OVER (PARTITION BY order_id) AS n
      FROM flagged
     WHERE prev_same IS NULL OR occurred_at - prev_same > make_interval(mins => v_dedupe);

    DELETE FROM attribution_result r USING _attr_orders a
     WHERE r.order_id = a.order_id AND r.model_key = p_model AND r.model_version = p_version;

    INSERT INTO attribution_result (workspace_id, brand_id, order_id, model_key, model_version, touchpoint_id, role, credit, touches_in_window)
    SELECT a.workspace_id, a.brand_id, a.order_id, p_model, p_version, t.touchpoint_id,
           CASE WHEN p_model = 'assisted' THEN 'assist' ELSE 'converting' END,
           CASE p_model WHEN 'linear' THEN (CASE WHEN t.rn_first = t.n THEN 1 - (t.n - 1) * round(1.0 / t.n, 6) ELSE round(1.0 / t.n, 6) END)
           WHEN 'assisted' THEN 0 ELSE 1 END,  -- linear: the last touch takes the rounding remainder (credits sum to 1)
           t.n
      FROM _attr_orders a
      JOIN _attr_touches t ON t.order_id = a.order_id
     WHERE (p_model = 'first_touch' AND t.rn_first = 1)
        OR (p_model = 'last_touch' AND t.rn_last = 1)
        OR (p_model = 'last_non_direct' AND t.rn_last_non_direct = 1)
        OR (p_model = 'linear')
        OR (p_model = 'assisted' AND t.rn_last_non_direct > 1 AND NOT t.is_direct);
    GET DIAGNOSTICS v_rows = ROW_COUNT;

    -- Orders without any touch: one explicit 'unattributed' row (never silently dropped).
    INSERT INTO attribution_result (workspace_id, brand_id, order_id, model_key, model_version, touchpoint_id, role, credit, touches_in_window)
    SELECT a.workspace_id, a.brand_id, a.order_id, p_model, p_version, NULL, 'converting', 1, 0
      FROM _attr_orders a
     WHERE p_model <> 'assisted' AND NOT EXISTS (SELECT 1 FROM _attr_touches t WHERE t.order_id = a.order_id);

    RETURN jsonb_build_object('model', p_model, 'version', p_version, 'orders', v_orders, 'touch_rows', v_rows,
                              'unattributed', (SELECT count(*) FROM attribution_result r JOIN _attr_orders a ON a.order_id = r.order_id
                                                WHERE r.model_key = p_model AND r.model_version = p_version AND r.touchpoint_id IS NULL));
END;
$$;
REVOKE ALL ON FUNCTION public.compute_attribution(UUID, TEXT, INT, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.compute_attribution(UUID, TEXT, INT, TIMESTAMPTZ) TO service_role;

-- ─── 11. Verified money per order (definitions) ──────────────────────────────────────────────
-- gross_order_value = order total (Shopify total_price) | paid_amount = captured Razorpay payments
-- linked to the order (NULL when no verified payment record applies) | refunded = Shopify refunds
-- (fallback: processed Razorpay refunds) | net_collected = paid - refunded (>= 0).
-- Browser events never contribute money.
CREATE OR REPLACE VIEW public.attribution_order_financials
WITH (security_invoker = true) AS
SELECT o.id AS order_id, o.workspace_id, o.brand_id, o.provider_id, o.order_number, o.currency,
       o.source_created_at AS ordered_at,
       o.gross_amount AS gross_order_value, o.discount_amount, o.tax_amount, o.shipping_amount,
       pay.captured AS paid_amount,
       CASE WHEN pay.n_captured > 0 THEN 'verified_payment'
            WHEN EXISTS (SELECT 1 FROM unnest(o.payment_gateways) g WHERE g ILIKE '%razorpay%') THEN 'awaiting_payment_record'
            ELSE 'unverified_gateway' END AS payment_verification,
       coalesce(o.refunded_amount, rz.refunded, 0) AS refunded_amount,
       CASE WHEN pay.n_captured > 0 THEN greatest(pay.captured - coalesce(o.refunded_amount, rz.refunded, 0), 0) END AS net_collected,
       CASE WHEN pay.n_captured = 0 OR pay.captured IS NULL THEN 'unpaid'
            WHEN pay.captured < o.gross_amount THEN 'partially_paid'
            WHEN pay.captured > o.gross_amount THEN 'overpaid'
            ELSE 'paid' END AS paid_status,
       coalesce(pay.n_failed, 0) AS failed_payment_attempts,
       (o.cancelled_at IS NOT NULL) AS is_cancelled,
       (coalesce(o.refunded_amount, rz.refunded, 0) > 0) AS is_refunded,
       o.financial_status
  FROM public.commerce_order o
  LEFT JOIN LATERAL (
      SELECT sum(p.amount_minor) FILTER (WHERE p.status IN ('captured', 'refunded')) AS captured,
             count(*) FILTER (WHERE p.status IN ('captured', 'refunded')) AS n_captured,
             count(*) FILTER (WHERE p.status = 'failed') AS n_failed
        FROM public.commerce_orderpaymentlink l JOIN public.commerce_paymentattempt p ON p.id = l.payment_attempt_id
       WHERE l.order_id = o.id) pay ON true
  LEFT JOIN LATERAL (
      SELECT sum(rf.amount_minor) AS refunded FROM public.commerce_refund rf
       WHERE rf.provider = 'razorpay' AND rf.status = 'processed'
         AND rf.payment_attempt_id IN (SELECT l.payment_attempt_id FROM public.commerce_orderpaymentlink l WHERE l.order_id = o.id)) rz ON true
 WHERE o.provider = 'shopify';

-- ─── 12. Reporting functions ──────────────────────────────────────────────────────────────────
-- Finest grain; callers roll up. unique_visitors is NOT additive across rows.
-- Ratios are NULL when their denominator is zero or unknown; nothing is fabricated.
CREATE OR REPLACE FUNCTION public.attribution_campaign_report(
    p_brand_id UUID, p_from DATE, p_to DATE, p_model TEXT, p_version INT)
RETURNS TABLE (
    report_date DATE, channel TEXT, utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, utm_content TEXT, utm_term TEXT,
    link_code TEXT, landing_path TEXT, meta_campaign_id TEXT,
    sessions BIGINT, unique_visitors BIGINT, product_views BIGINT, add_to_carts BIGINT, checkouts BIGINT,
    attributed_orders NUMERIC, attributed_paid_orders NUMERIC, gross_attributed_order_value NUMERIC,
    attributed_collected_revenue NUMERIC, attributed_refunds NUMERIC, attributed_net_collected NUMERIC,
    unverified_order_value NUMERIC, conversion_rate NUMERIC, average_order_value NUMERIC)
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
WITH tz AS (SELECT timezone FROM tenancy_brand WHERE id = p_brand_id),
traffic AS (
    SELECT (t.occurred_at AT TIME ZONE (SELECT timezone FROM tz))::date AS d, t.channel, t.utm_source, t.utm_medium, t.utm_campaign,
           t.utm_content, t.utm_term, l.link_code, t.landing_path, t.meta_campaign_id,
           count(*) AS sessions, count(DISTINCT t.visitor_id) AS unique_visitors,
           sum(ev.product_views) AS product_views, sum(ev.add_to_carts) AS add_to_carts, sum(ev.checkouts) AS checkouts
      FROM attribution_touchpoint t
      LEFT JOIN attribution_link l ON l.id = t.link_id
      LEFT JOIN LATERAL (SELECT count(*) FILTER (WHERE e.event_name = 'product_view') AS product_views,
                                count(*) FILTER (WHERE e.event_name = 'add_to_cart') AS add_to_carts,
                                count(*) FILTER (WHERE e.event_name = 'begin_checkout') AS checkouts
                           FROM attribution_event e WHERE e.session_id = t.session_id) ev ON true
     WHERE t.brand_id = p_brand_id AND t.touch_type = 'session'
       AND (t.occurred_at AT TIME ZONE (SELECT timezone FROM tz))::date BETWEEN p_from AND p_to
     GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10
), revenue AS (
    SELECT (f.ordered_at AT TIME ZONE (SELECT timezone FROM tz))::date AS d,
           coalesce(t.channel, 'unattributed') AS channel, t.utm_source, t.utm_medium, t.utm_campaign, t.utm_content, t.utm_term,
           l.link_code, t.landing_path, t.meta_campaign_id,
           sum(r.credit) AS orders,
           sum(r.credit) FILTER (WHERE f.paid_status IN ('paid', 'overpaid')) AS paid_orders,
           sum(r.credit * f.gross_order_value) AS gross_value,
           sum(r.credit * f.paid_amount) FILTER (WHERE f.payment_verification = 'verified_payment') AS collected,
           sum(r.credit * f.refunded_amount) AS refunds,
           sum(r.credit * f.net_collected) FILTER (WHERE f.payment_verification = 'verified_payment') AS net_collected,
           sum(r.credit * f.gross_order_value) FILTER (WHERE f.payment_verification <> 'verified_payment') AS unverified
      FROM attribution_result r
      JOIN attribution_order_financials f ON f.order_id = r.order_id
      LEFT JOIN attribution_touchpoint t ON t.id = r.touchpoint_id
      LEFT JOIN attribution_link l ON l.id = t.link_id
     WHERE r.brand_id = p_brand_id AND r.model_key = p_model AND r.model_version = p_version AND r.role = 'converting'
       AND (f.ordered_at AT TIME ZONE (SELECT timezone FROM tz))::date BETWEEN p_from AND p_to
     GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10
)
SELECT coalesce(tr.d, rv.d), coalesce(tr.channel, rv.channel), coalesce(tr.utm_source, rv.utm_source), coalesce(tr.utm_medium, rv.utm_medium),
       coalesce(tr.utm_campaign, rv.utm_campaign), coalesce(tr.utm_content, rv.utm_content), coalesce(tr.utm_term, rv.utm_term),
       coalesce(tr.link_code, rv.link_code), coalesce(tr.landing_path, rv.landing_path), coalesce(tr.meta_campaign_id, rv.meta_campaign_id),
       coalesce(tr.sessions, 0), coalesce(tr.unique_visitors, 0), coalesce(tr.product_views, 0), coalesce(tr.add_to_carts, 0), coalesce(tr.checkouts, 0),
       coalesce(rv.orders, 0), coalesce(rv.paid_orders, 0), coalesce(rv.gross_value, 0),
       rv.collected, coalesce(rv.refunds, 0), rv.net_collected, rv.unverified,
       CASE WHEN coalesce(tr.sessions, 0) > 0 THEN round(coalesce(rv.orders, 0) / tr.sessions, 4) END,
       CASE WHEN coalesce(rv.orders, 0) > 0 THEN round(rv.gross_value / rv.orders, 2) END
  FROM traffic tr
  FULL OUTER JOIN revenue rv
    ON rv.d = tr.d AND rv.channel = tr.channel
   AND rv.utm_source IS NOT DISTINCT FROM tr.utm_source AND rv.utm_medium IS NOT DISTINCT FROM tr.utm_medium
   AND rv.utm_campaign IS NOT DISTINCT FROM tr.utm_campaign AND rv.utm_content IS NOT DISTINCT FROM tr.utm_content
   AND rv.utm_term IS NOT DISTINCT FROM tr.utm_term AND rv.link_code IS NOT DISTINCT FROM tr.link_code
   AND rv.landing_path IS NOT DISTINCT FROM tr.landing_path AND rv.meta_campaign_id IS NOT DISTINCT FROM tr.meta_campaign_id;
$$;
REVOKE ALL ON FUNCTION public.attribution_campaign_report(UUID, DATE, DATE, TEXT, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.attribution_campaign_report(UUID, DATE, DATE, TEXT, INT) TO authenticated, service_role;

-- Meta: platform-reported vs internally attributed. Different definitions by design (see report).
CREATE OR REPLACE FUNCTION public.attribution_meta_comparison(p_brand_id UUID, p_from DATE, p_to DATE)
RETURNS TABLE (
    meta_campaign_id TEXT, campaign_name TEXT, attribution_setting TEXT,
    spend NUMERIC, meta_purchases NUMERIC, meta_purchase_value NUMERIC,
    internal_last_touch_orders NUMERIC, internal_first_touch_orders NUMERIC,
    internal_last_touch_collected NUMERIC, internal_first_touch_collected NUMERIC,
    roas_meta_reported NUMERIC, roas_internal_collected NUMERIC, cpa_internal NUMERIC)
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
WITH tz AS (SELECT timezone FROM tenancy_brand WHERE id = p_brand_id),
meta AS (
    SELECT m.campaign_id, max(m.campaign_name) AS campaign_name, string_agg(DISTINCT m.attribution_setting, ',') AS attribution_setting,
           sum(m.spend_minor) AS spend, sum(m.purchases) AS purchases, sum(m.purchase_value_minor) AS purchase_value
      FROM analytics_meta_ad_daily m
     WHERE m.brand_id = p_brand_id AND m.report_date BETWEEN p_from AND p_to
     GROUP BY m.campaign_id
), internal AS (
    SELECT t.meta_campaign_id AS campaign_id,
           sum(r.credit) FILTER (WHERE r.model_key = 'last_touch') AS lt_orders,
           sum(r.credit) FILTER (WHERE r.model_key = 'first_touch') AS ft_orders,
           sum(r.credit * f.paid_amount) FILTER (WHERE r.model_key = 'last_touch' AND f.payment_verification = 'verified_payment') AS lt_collected,
           sum(r.credit * f.paid_amount) FILTER (WHERE r.model_key = 'first_touch' AND f.payment_verification = 'verified_payment') AS ft_collected
      FROM attribution_result r
      JOIN attribution_touchpoint t ON t.id = r.touchpoint_id
      JOIN attribution_order_financials f ON f.order_id = r.order_id
     WHERE r.brand_id = p_brand_id AND r.model_version = 1 AND r.model_key IN ('last_touch', 'first_touch')
       AND t.meta_campaign_id IS NOT NULL
       AND (f.ordered_at AT TIME ZONE (SELECT timezone FROM tz))::date BETWEEN p_from AND p_to
     GROUP BY 1
)
SELECT coalesce(m.campaign_id, i.campaign_id), m.campaign_name, m.attribution_setting,
       m.spend, m.purchases, m.purchase_value, i.lt_orders, i.ft_orders, i.lt_collected, i.ft_collected,
       CASE WHEN m.spend > 0 AND m.purchase_value IS NOT NULL THEN round(m.purchase_value / m.spend, 4) END,
       CASE WHEN m.spend > 0 AND i.lt_collected IS NOT NULL THEN round(i.lt_collected / m.spend, 4) END,
       CASE WHEN m.spend IS NOT NULL AND coalesce(i.lt_orders, 0) > 0 THEN round(m.spend / i.lt_orders, 2) END
  FROM meta m FULL OUTER JOIN internal i ON i.campaign_id = m.campaign_id;
$$;
REVOKE ALL ON FUNCTION public.attribution_meta_comparison(UUID, DATE, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.attribution_meta_comparison(UUID, DATE, DATE) TO authenticated, service_role;

-- ─── 13. Maintenance + retention ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.run_attribution_maintenance()
RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    b RECORD;
    m RECORD;
    n INT := 0;
BEGIN
    FOR b IN SELECT DISTINCT brand_id AS id FROM commerce_order WHERE provider = 'shopify' LOOP
        PERFORM link_attribution_conversions(b.id);
        FOR m IN SELECT model_key, max(version) AS version FROM attribution_model GROUP BY model_key LOOP
            PERFORM compute_attribution(b.id, m.model_key, m.version, clock_timestamp() - INTERVAL '120 days');
        END LOOP;
        n := n + 1;
    END LOOP;
    RETURN n;
END;
$$;
REVOKE ALL ON FUNCTION public.run_attribution_maintenance() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_attribution_maintenance() TO service_role;

-- Re-applies the channel rules to stored touches (after a rule change). The raw UTM values never
-- change; only the derived channel / Meta ids / link are recomputed by the trigger.
CREATE OR REPLACE FUNCTION public.reclassify_touchpoints(p_brand_id UUID)
RETURNS INTEGER LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v_n INT;
BEGIN
    UPDATE attribution_touchpoint SET utm_source = utm_source WHERE brand_id = p_brand_id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RETURN v_n;
END $$;
REVOKE ALL ON FUNCTION public.reclassify_touchpoints(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reclassify_touchpoints(UUID) TO service_role;

-- Deletes raw pixel events older than the brand's retention_days. Only runs for brands where a
-- retention period was explicitly configured (NULL = keep). Not scheduled automatically.
CREATE OR REPLACE FUNCTION public.purge_attribution_events(p_brand_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_days INT;
    v_n INT;
BEGIN
    SELECT retention_days INTO v_days FROM attribution_site WHERE brand_id = p_brand_id;
    IF v_days IS NULL THEN RETURN 0; END IF;
    DELETE FROM attribution_event WHERE brand_id = p_brand_id AND source = 'pixel'
       AND occurred_at < clock_timestamp() - make_interval(days => v_days);
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION public.purge_attribution_events(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_attribution_events(UUID) TO service_role;

DO $outer$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
        PERFORM cron.schedule('attribution-maintenance', '50 * * * *', $c$SELECT public.run_attribution_maintenance()$c$);
    ELSE
        RAISE NOTICE 'pg_cron not installed: attribution-maintenance not scheduled';
    END IF;
END
$outer$;

-- ─── 14. Row level security: members read their brand; writes via service role only ──────────
DO $$
DECLARE
    v_tbl TEXT;
BEGIN
    FOREACH v_tbl IN ARRAY ARRAY['attribution_link', 'attribution_visitor', 'attribution_session', 'attribution_event',
        'attribution_touchpoint', 'attribution_conversion', 'attribution_settings', 'attribution_result'] LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_tbl);
        EXECUTE format('DROP POLICY IF EXISTS rls_%s_select ON public.%I', v_tbl, v_tbl);
        EXECUTE format('CREATE POLICY rls_%s_select ON public.%I FOR SELECT TO authenticated, app_user USING (public.has_brand_access(brand_id))', v_tbl, v_tbl);
        EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon', v_tbl);
        EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.%I FROM authenticated', v_tbl);
        EXECUTE format('GRANT SELECT ON public.%I TO authenticated', v_tbl);
        EXECUTE format('GRANT ALL ON public.%I TO service_role', v_tbl);
    END LOOP;
END $$;

-- Site config: owners/admins only (allowed origins, retention).
ALTER TABLE public.attribution_site ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_attribution_site_select ON public.attribution_site;
CREATE POLICY rls_attribution_site_select ON public.attribution_site FOR SELECT TO authenticated, app_user
    USING (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin']));
REVOKE ALL ON public.attribution_site FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.attribution_site FROM authenticated;
GRANT SELECT ON public.attribution_site TO authenticated;
GRANT ALL ON public.attribution_site TO service_role;

-- Global reference data: readable, not writable by users.
ALTER TABLE public.attribution_model ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attribution_channel_rule ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_attribution_model_select ON public.attribution_model;
CREATE POLICY rls_attribution_model_select ON public.attribution_model FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS rls_attribution_channel_rule_select ON public.attribution_channel_rule;
CREATE POLICY rls_attribution_channel_rule_select ON public.attribution_channel_rule FOR SELECT TO authenticated
    USING (brand_id IS NULL OR public.has_brand_access(brand_id));
REVOKE ALL ON public.attribution_model, public.attribution_channel_rule FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.attribution_model, public.attribution_channel_rule FROM authenticated;
GRANT SELECT ON public.attribution_model, public.attribution_channel_rule TO authenticated;
GRANT ALL ON public.attribution_model, public.attribution_channel_rule TO service_role;

REVOKE ALL ON public.attribution_order_financials FROM PUBLIC, anon;
GRANT SELECT ON public.attribution_order_financials TO authenticated, service_role;
