-- Reports → 💸 Ads ROI (meta-ads-report.js). The Worker also creates these tables lazily
-- (marEnsureSchema), so an un-migrated database still works; this file documents the schema.

-- Meta Ads Insights, one row per ad per day (account timezone). Replaced window by window on each
-- sync: 90 days on first use, the last 3 days every morning, 30 days on "Sync now".
CREATE TABLE IF NOT EXISTS meta_ads_daily (
  client_id INTEGER NOT NULL,
  day TEXT NOT NULL,              -- YYYY-MM-DD
  ad_id TEXT NOT NULL,
  ad_name TEXT,
  adset_id TEXT,
  adset_name TEXT,
  campaign_id TEXT,
  campaign_name TEXT,
  spend REAL NOT NULL DEFAULT 0,  -- account currency
  impressions INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  meta_leads INTEGER NOT NULL DEFAULT 0,  -- leads as Meta counts them (lead forms)
  meta_chats INTEGER NOT NULL DEFAULT 0,  -- messaging conversations started (click-to-WhatsApp)
  currency TEXT,
  synced_at TEXT,
  PRIMARY KEY (client_id, day, ad_id)
);

-- One row per account: settings (config_json) and sync status. last_daily_day claims the morning
-- run (sync → accounting → summary) so the 15-minute cron does each account once a day.
CREATE TABLE IF NOT EXISTS meta_ads_report_state (
  client_id INTEGER PRIMARY KEY,
  config_json TEXT NOT NULL DEFAULT '{}',
  account_name TEXT,
  currency TEXT,
  tz_offset_min INTEGER NOT NULL DEFAULT 0,
  backfilled_from TEXT,
  last_attempt_at TEXT,
  last_ok_at TEXT,
  last_error TEXT,
  last_daily_day TEXT,
  updated_at TEXT
);

-- Every daily summary / alert / test message attempt (sent, failed, skipped), per recipient.
CREATE TABLE IF NOT EXISTS meta_ads_report_sends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  kind TEXT NOT NULL,             -- 'summary' | 'alerts' | 'test'
  day TEXT NOT NULL,
  recipient TEXT,
  status TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_meta_ads_report_sends_client ON meta_ads_report_sends(client_id, day);

-- The accounting_expenses row holding each month's Meta spend. status 'deleted' = the user removed
-- the expense, so it is never recreated.
CREATE TABLE IF NOT EXISTS meta_ads_expense_posts (
  client_id INTEGER NOT NULL,
  month TEXT NOT NULL,            -- YYYY-MM
  expense_id INTEGER,
  amount REAL NOT NULL DEFAULT 0,
  currency TEXT,
  status TEXT NOT NULL,           -- 'posted' | 'deleted'
  updated_at TEXT NOT NULL,
  PRIMARY KEY (client_id, month)
);

-- Which key matched each Conversions API event to the ad click: 'ctwa_clid' (click-to-WhatsApp),
-- 'lead_id' (Instant Form) or 'hashed' (phone/email only). Shown in Ads ROI → Results sent to Meta.
ALTER TABLE meta_capi_events ADD COLUMN match_key TEXT;
