-- =====================================================================================
-- 125East: Edge Function health check. Paste into Supabase -> SQL Editor and run.
--
-- The script runs in TWO parts:
--   PART 1  fires a set of test calls to every Edge Function (from inside the database)
--   PART 2  shows the HTTP answers. Run PART 2 about 10 seconds AFTER PART 1.
-- Nothing is written to your business tables. The cron secret is read from the vault
-- and is never displayed.
-- =====================================================================================

-- -------------------------------------------------------------------------------------
-- PART 1: fire the test calls (run this block first)
-- -------------------------------------------------------------------------------------
do $$
declare
  v_base  text := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/';
  v_anon  text := (select decrypted_secret from vault.decrypted_secrets where name = 'anon_key');
  v_cron  text := (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret');
  v_json  jsonb := '{"Content-Type":"application/json"}'::jsonb;
  v_brand text := '00000000-0000-0000-0000-000000000000';   -- a brand that does not exist
  f       text;
begin
  -- 1. No credentials at all: every sync function must refuse (expect 401).
  foreach f in array array['shopify-sync','razorpay-sync','meta-ads-sync','instagram-sync',
                           'test-connection','delhivery-sync','reprocess-raw'] loop
    perform net.http_post(url := v_base || f, headers := v_json, body := '{}'::jsonb);
  end loop;

  -- 2. Anon key used as a user token: must be refused (expect 401).
  perform net.http_post(url := v_base || 'shopify-sync',
    headers := v_json || jsonb_build_object('apikey', v_anon, 'Authorization', 'Bearer ' || v_anon),
    body := '{}'::jsonb);

  -- 3. Scheduler secret, correct: authenticates, then fails on the missing workspace (expect 400).
  perform net.http_post(url := v_base || 'shopify-sync',
    headers := v_json || jsonb_build_object('x-cron-secret', v_cron, 'Authorization', 'Bearer ' || v_anon),
    body := '{}'::jsonb);

  -- 4. Scheduler secret, WRONG: must be refused (expect 401).
  perform net.http_post(url := v_base || 'shopify-sync',
    headers := v_json || jsonb_build_object('x-cron-secret', 'wrong-secret-value-xxxxxxxxxxxxxxxxxxxxxxx',
                                             'Authorization', 'Bearer ' || v_anon),
    body := '{}'::jsonb);

  -- 5. Webhooks without a signature: must be refused (expect 401).
  perform net.http_post(url := v_base || 'webhook-shopify?brand_id=' || v_brand,
    headers := v_json || jsonb_build_object('x-shopify-topic', 'orders/create'), body := '{"id":1}'::jsonb);
  perform net.http_post(url := v_base || 'webhook-razorpay?brand_id=' || v_brand,
    headers := v_json, body := '{"event":"payment.captured"}'::jsonb);

  -- 6. Storefront tracker without an Origin header: must be refused (expect 403).
  perform net.http_post(url := v_base || 'track', headers := v_json, body := '{}'::jsonb);

  raise notice 'Test calls sent. Now run PART 2 (wait ~10 seconds first).';
end $$;


-- -------------------------------------------------------------------------------------
-- PART 2: show the answers (run this after PART 1)
-- Expected in the "expect" column. "OK" means the function behaves correctly.
-- -------------------------------------------------------------------------------------
-- PART 1 sends these 13 calls in this order. PART 2 reads the 13 most recent answers in the same order.
with calls(n, check_name, expected) as (values
  (1,  'shopify-sync      no login',                 401),
  (2,  'razorpay-sync     no login',                 401),
  (3,  'meta-ads-sync     no login',                 401),
  (4,  'instagram-sync    no login',                 401),
  (5,  'test-connection   no login',                 401),
  (6,  'delhivery-sync    no login',                 401),
  (7,  'reprocess-raw     no login',                 401),
  (8,  'shopify-sync      anon key as user',         401),
  (9,  'shopify-sync      correct scheduler secret', 400),
  (10, 'shopify-sync      WRONG scheduler secret',   401),
  (11, 'webhook-shopify   unsigned',                 401),
  (12, 'webhook-razorpay  unsigned',                 401),
  (13, 'track             no origin',                403)
),
answers as (
  select row_number() over (order by id) as n, id, status_code, content
  from (select * from net._http_response order by id desc limit 13) r
)
select
  c.n                                                       as "#",
  c.check_name                                              as check_name,
  coalesce(a.status_code::text, 'no answer yet')            as http_status,
  c.expected                                                as expected,
  case when a.status_code = c.expected then 'PASS' when a.status_code is null then 'WAIT: run PART 2 again' else 'FAIL' end as result,
  left(coalesce(a.content::text, ''), 100)  as reply
from calls c left join answers a on a.n = c.n
order by c.n;

-- If a row shows "WAIT", wait a few seconds and run PART 2 again.
-- A scheduled sync can add its own answers at the same time; if a row looks out of order, run PART 1 again.

-- Scheduler rows: correct secret -> 400 "Missing required workspace_id" (the secret was accepted, then the empty
-- request was rejected) = PASS. Wrong secret -> 401 "Invalid scheduler credentials" = PASS.


-- -------------------------------------------------------------------------------------
-- PART 3: scheduler and data health (read-only)
-- -------------------------------------------------------------------------------------

-- 3a. Scheduled jobs: all should be active.
select jobname, schedule, active from cron.job order by jobname;

-- 3b. Last 10 scheduled runs: status should be 'succeeded'.
select j.jobname, d.status, left(coalesce(d.return_message, ''), 80) as message, d.start_time
from cron.job_run_details d join cron.job j on j.jobid = d.jobid
order by d.start_time desc limit 10;

-- 3c. Integrations: status per connection (connected = working; error = needs new credentials).
select b.name as brand, i.provider, i.status, i.last_synced_at
from integrations_integration i join tenancy_brand b on b.id = i.brand_id
order by b.name, i.provider;

-- 3d. Most recent sync runs and their outcome.
select r.resource, r.status, r.records_processed, r.records_created,
       r.records_updated, r.started_at, left(coalesce(r.error_message, ''), 100) as error
from integrations_syncrun r
order by r.started_at desc limit 15;

-- 3e. Webhook events received (counts per provider; 'failed' rows need a look).
select provider, processed, count(*) as events, count(*) filter (where error is not null) as with_error
from integrations_webhookevent
group by provider, processed order by provider, processed;

-- 3f. Raw payloads that failed processing (reprocess-raw can retry these).
select provider, topic, count(*) as failed_payloads
from integrations_rawpayload
where processing_status = 'failed'
group by provider, topic order by failed_payloads desc;

-- 3g. Vault secrets present (names only).
select name from vault.decrypted_secrets order by name;
