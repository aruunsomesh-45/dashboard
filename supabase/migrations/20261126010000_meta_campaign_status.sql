-- Campaign status (ACTIVE / PAUSED / ...) for each ad-level Meta row, filled by meta-ads-sync.
ALTER TABLE public.analytics_meta_ad_daily ADD COLUMN IF NOT EXISTS campaign_status VARCHAR(30) NULL;
