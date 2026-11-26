-- =====================================================================================
-- Scheduled synchronisation (Supabase Cron) + sync overlap lock + sync health view.
--
-- Flow:  pg_cron  ->  public.enqueue_scheduled_syncs(provider)  ->  pg_net HTTP POST
--        ->  <provider>-sync Edge Function (header x-cron-secret)  ->  integrations_syncrun
--
-- Additive only: no table, column or row is dropped. The one data change closes sync runs
-- that are still marked `running` but are already abandoned (needed for the unique index).
--
-- Activation requires three Vault secrets (set by an operator, NEVER committed):
--   select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
--   select vault.create_secret('<anon/publishable JWT>',            'anon_key');
--   select vault.create_secret('<random >= 32 chars>',              'cron_secret');
-- plus the Edge Function secret CRON_SECRET with the same value as `cron_secret`.
-- Until those exist every scheduled tick is a no-op (it logs a WARNING and returns 0).
--
-- The pg_cron / pg_net part is guarded so this file also replays on plain PostgreSQL
-- (local PGlite test database), where those extensions do not exist.
-- =====================================================================================

-- 1. Sync history: who triggered the run --------------------------------------------------
ALTER TABLE public.integrations_syncrun
    ADD COLUMN IF NOT EXISTS triggered_by VARCHAR(10) NOT NULL DEFAULT 'manual';

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_integrations_syncrun_triggered_by') THEN
        ALTER TABLE public.integrations_syncrun
            ADD CONSTRAINT chk_integrations_syncrun_triggered_by CHECK (triggered_by IN ('manual', 'cron'));
    END IF;
END $$;

-- 2. Overlap lock: at most one running sync per (integration, resource) ----------------------
UPDATE public.integrations_syncrun s
   SET status = 'failed',
       finished_at = clock_timestamp(),
       error_message = 'Abandoned: closed by migration 20261123120000 (no completion recorded)'
 WHERE s.status = 'running'
   AND (
        s.started_at < clock_timestamp() - INTERVAL '15 minutes'
     OR EXISTS (
          SELECT 1 FROM public.integrations_syncrun t
           WHERE t.integration_id = s.integration_id
             AND t.resource = s.resource
             AND t.status = 'running'
             AND (t.started_at, t.id) > (s.started_at, s.id)
        )
   );

CREATE UNIQUE INDEX IF NOT EXISTS uq_syncrun_one_running
    ON public.integrations_syncrun (integration_id, resource)
    WHERE status = 'running';

CREATE INDEX IF NOT EXISTS idx_syncrun_integration_started
    ON public.integrations_syncrun (integration_id, started_at DESC);

-- 3. Health view: last run, last success, status, error, failure streak, records ----------
--    security_invoker => the caller's RLS on the base tables applies (workspace isolation).
CREATE OR REPLACE VIEW public.integrations_sync_health
WITH (security_invoker = true) AS
SELECT
    i.id                      AS integration_id,
    i.workspace_id,
    i.brand_id,
    i.provider,
    i.status                  AS integration_status,
    i.last_error_message,
    lr.started_at             AS last_run_at,
    lr.finished_at            AS last_run_finished_at,
    lr.status                 AS last_run_status,
    lr.triggered_by           AS last_run_triggered_by,
    lr.records_processed      AS last_records_processed,
    lr.error_message          AS last_run_error,
    ls.finished_at            AS last_success_at,
    (SELECT count(*)
       FROM public.integrations_syncrun f
      WHERE f.integration_id = i.id
        AND f.status = 'failed'
        AND f.started_at > COALESCE(ls.started_at, '-infinity'::timestamptz))::int AS consecutive_failures,
    EXISTS (SELECT 1 FROM public.integrations_syncrun r
             WHERE r.integration_id = i.id AND r.status = 'running') AS is_running
FROM public.integrations_integration i
LEFT JOIN LATERAL (
    SELECT r.* FROM public.integrations_syncrun r
     WHERE r.integration_id = i.id
     ORDER BY r.started_at DESC LIMIT 1
) lr ON true
LEFT JOIN LATERAL (
    SELECT r.* FROM public.integrations_syncrun r
     WHERE r.integration_id = i.id AND r.status IN ('success', 'partial')
     ORDER BY r.started_at DESC LIMIT 1
) ls ON true;

REVOKE ALL ON public.integrations_sync_health FROM PUBLIC, anon;
GRANT SELECT ON public.integrations_sync_health TO authenticated, service_role;

-- 4. Dispatcher called by pg_cron ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enqueue_scheduled_syncs(p_provider TEXT, p_options JSONB DEFAULT '{}'::jsonb)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_function TEXT;
    v_url      TEXT;
    v_anon     TEXT;
    v_secret   TEXT;
    v_count    INTEGER := 0;
    r          RECORD;
BEGIN
    v_function := CASE p_provider
        WHEN 'shopify'   THEN 'shopify-sync'
        WHEN 'razorpay'  THEN 'razorpay-sync'
        WHEN 'meta_ads'  THEN 'meta-ads-sync'
        WHEN 'instagram' THEN 'instagram-sync'
    END;
    IF v_function IS NULL THEN
        RAISE EXCEPTION 'enqueue_scheduled_syncs: unsupported provider %', p_provider USING ERRCODE = '22023';
    END IF;

    SELECT decrypted_secret INTO v_url    FROM vault.decrypted_secrets WHERE name = 'project_url';
    SELECT decrypted_secret INTO v_anon   FROM vault.decrypted_secrets WHERE name = 'anon_key';
    SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret';
    IF v_url IS NULL OR v_anon IS NULL OR coalesce(length(v_secret), 0) < 32 THEN
        RAISE WARNING 'scheduled % sync skipped: Vault secrets project_url / anon_key / cron_secret (>= 32 chars) are not configured', p_provider;
        RETURN 0;
    END IF;

    FOR r IN
        SELECT i.workspace_id, i.brand_id
          FROM public.integrations_integration i
         WHERE i.provider = p_provider
           AND i.status = 'connected'           -- broken credentials are not retried every tick
           AND NOT EXISTS (                     -- module switched off for the workspace
                 SELECT 1 FROM public.workspace_module_permissions w
                  WHERE w.workspace_id = i.workspace_id
                    AND w.module_key = p_provider
                    AND w.enabled = false)
           AND NOT EXISTS (                     -- previous run still in progress
                 SELECT 1 FROM public.integrations_syncrun s
                  WHERE s.integration_id = i.id
                    AND s.status = 'running'
                    AND s.started_at > clock_timestamp() - INTERVAL '15 minutes')
    LOOP
        PERFORM net.http_post(
            url := rtrim(v_url, '/') || '/functions/v1/' || v_function,
            headers := jsonb_build_object(
                'Content-Type', 'application/json',
                'Authorization', 'Bearer ' || v_anon,
                'x-cron-secret', v_secret),
            body := jsonb_build_object('workspace_id', r.workspace_id, 'brand_id', r.brand_id) || coalesce(p_options, '{}'::jsonb),
            timeout_milliseconds := 150000
        );
        v_count := v_count + 1;
    END LOOP;
    RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_scheduled_syncs(TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_scheduled_syncs(TEXT, JSONB) TO service_role;

-- 5. Housekeeping: close runs whose function died without reporting ---------------------------
CREATE OR REPLACE FUNCTION public.expire_stale_sync_runs()
RETURNS INTEGER
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    WITH closed AS (
        UPDATE public.integrations_syncrun
           SET status = 'failed',
               finished_at = clock_timestamp(),
               error_message = 'Abandoned: no completion recorded within 15 minutes'
         WHERE status = 'running'
           AND started_at < clock_timestamp() - INTERVAL '15 minutes'
        RETURNING 1)
    SELECT count(*)::int FROM closed;
$$;

REVOKE ALL ON FUNCTION public.expire_stale_sync_runs() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.expire_stale_sync_runs() TO service_role;

-- 6. Schedules (only where pg_cron + pg_net are available, i.e. hosted Supabase) ---------------
--    Shopify/Razorpay run incrementally from integrations_synccursor (10-min overlap; first run = 90/30-day backfill).
--    Shopify/Razorpay: 15 min (webhooks are the real-time path; polling is the safety net).
--    Meta Ads: 6 h, 3-day window (Meta restates conversions for ~72 h).
--    Instagram: 12 h (account health only; no insights table exists yet).
DO $outer$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron')
       AND EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_net') THEN
        CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
        CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

        PERFORM cron.schedule('sync-shopify',   '*/15 * * * *',
            $c$SELECT public.enqueue_scheduled_syncs('shopify',  '{"max_pages":5}'::jsonb)$c$);
        PERFORM cron.schedule('sync-razorpay',  '5,20,35,50 * * * *',
            $c$SELECT public.enqueue_scheduled_syncs('razorpay', '{"max_pages":5}'::jsonb)$c$);
        PERFORM cron.schedule('sync-meta-ads',  '10 */6 * * *',
            $c$SELECT public.enqueue_scheduled_syncs('meta_ads', '{"days":3,"max_pages":5}'::jsonb)$c$);
        PERFORM cron.schedule('sync-instagram', '40 */12 * * *',
            $c$SELECT public.enqueue_scheduled_syncs('instagram')$c$);
        PERFORM cron.schedule('sync-expire-stale-runs', '*/30 * * * *',
            $c$SELECT public.expire_stale_sync_runs()$c$);
    ELSE
        RAISE NOTICE 'pg_cron/pg_net not available: scheduled sync jobs not created';
    END IF;
END
$outer$;
