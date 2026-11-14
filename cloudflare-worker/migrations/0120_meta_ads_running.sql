-- Reports → 💸 Ads ROI: which ads ran when, and matching leads to them (meta-ads-report.js).
-- The Worker also creates these lazily (marEnsureSchema); this file documents the schema.

-- Meta Ads Insights per ad per hour (account timezone), last 30 days — leads with no ad id are
-- shared across the ads that were running in the hour they arrived.
CREATE TABLE IF NOT EXISTS meta_ads_hourly (
  client_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  hour INTEGER NOT NULL,          -- 0..23
  ad_id TEXT NOT NULL,
  spend REAL NOT NULL DEFAULT 0,
  meta_leads INTEGER NOT NULL DEFAULT 0,
  meta_chats INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (client_id, day, hour, ad_id)
);

-- Every ad's current status, ad set / campaign and creative text (headline/body — matched against
-- a lead's first message).
CREATE TABLE IF NOT EXISTS meta_ads_ads (
  client_id INTEGER NOT NULL,
  ad_id TEXT NOT NULL,
  ad_name TEXT,
  adset_id TEXT,
  adset_name TEXT,
  campaign_id TEXT,
  campaign_name TEXT,
  status TEXT,                    -- Meta effective_status: ACTIVE, PAUSED, CAMPAIGN_PAUSED, DISAPPROVED…
  adset_status TEXT,
  campaign_status TEXT,
  headline TEXT,
  body TEXT,
  updated_at TEXT,
  PRIMARY KEY (client_id, ad_id)
);

-- A new ad or a status change seen by a sync ("Active → Paused").
CREATE TABLE IF NOT EXISTS meta_ads_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  at TEXT NOT NULL,
  day TEXT NOT NULL,
  ad_id TEXT,
  ad_name TEXT,
  campaign_name TEXT,
  kind TEXT NOT NULL,             -- 'new' | 'status'
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_meta_ads_changes_client ON meta_ads_changes(client_id, day);
