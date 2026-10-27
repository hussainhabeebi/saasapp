-- Reports → 💸 Ads ROI growth tools (meta-ads-report.js; worker.js metaCapiLogError). The Worker
-- also creates these lazily; this file documents the schema.

-- Daily budgets per ad set / campaign (account currency, major units; 0 = budget set elsewhere) —
-- what the sales-based rules propose changes to.
-- Not ALTERed here: meta-ads-report.js adds adset_budget REAL and campaign_budget REAL to meta_ads_ads
-- lazily, so on a live database they usually exist already and an ALTER would fail the migration
-- with "duplicate column name".

-- Every Conversions API event Meta refused or that never reached it (🩺 Tracking health, daily alert).
CREATE TABLE IF NOT EXISTS meta_capi_errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  event TEXT NOT NULL,
  lead_id INTEGER,
  code TEXT,
  error TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_meta_capi_errors_client ON meta_capi_errors(client_id, at);

-- CRM audiences kept in the ad account, refreshed daily (buyers, hot_not_bought, exclude, high_value).
CREATE TABLE IF NOT EXISTS meta_ads_audiences (
  client_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  audience_id TEXT,
  lookalike_id TEXT,
  size INTEGER NOT NULL DEFAULT 0,  -- people uploaded on the last refresh
  last_run_at TEXT,
  last_error TEXT,
  PRIMARY KEY (client_id, key)
);

-- Budget / pause changes approved in Ads ROI, with what they were before (Undo).
CREATE TABLE IF NOT EXISTS meta_ads_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  at TEXT NOT NULL,
  actor TEXT,
  target_type TEXT NOT NULL,        -- 'adset' | 'campaign'
  target_id TEXT NOT NULL,
  target_name TEXT,
  action TEXT NOT NULL,             -- 'pause' | 'budget_down' | 'budget_up' | 'undo'
  before_json TEXT,
  after_json TEXT,
  reason TEXT,
  status TEXT NOT NULL,             -- 'ok' | 'error' | 'undone'
  error TEXT,
  undone_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_meta_ads_actions_client ON meta_ads_actions(client_id, at);
