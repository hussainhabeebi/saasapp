-- Meta Ads Automation module (standalone tab, Reports page → 🤖 Ads Automation — see SETUP.md
-- "Meta Ads Automation module"). Distinct from the read-only Marketing/ROI tab (meta_capi_events,
-- migrations/0003_meta_capi_log.sql) — this logs every WRITE-capable action a client actually ran
-- against Meta's Marketing API (suppression sync, lookalike refresh, budget shift, fatigue check),
-- manual-only for this first version (no cron), one row per "Run now" click either way (ok or
-- error) so there's an audit trail of what really happened to a client's live ad account.
CREATE TABLE IF NOT EXISTS meta_ads_automation_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  automation TEXT NOT NULL,    -- 'suppression' | 'lookalike' | 'budget_shift' | 'fatigue'
  status TEXT NOT NULL,        -- 'ok' | 'error'
  summary TEXT NOT NULL DEFAULT '',
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_meta_ads_automation_runs_client ON meta_ads_automation_runs(client_id, automation, created_at);
