-- Scheduled Report Builder (Reports page → 🗓️ Scheduled Reports). One row per report a client has
-- built — multiple reports per client are just multiple rows, same as re_channel_partners/
-- fp_expected_dues etc. `sections` is a JSON array of REPORT_SECTIONS keys (worker.js) picked in
-- the builder. `weekly_day` (0=Sunday..6=Saturday, UTC) is only read when frequency='weekly'.
-- `last_sent_at` guards against double-sending if the daily cron tick ever fires twice in the same
-- UTC day (runScheduledReportsForAllClients skips a report already sent today).
CREATE TABLE IF NOT EXISTS scheduled_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  sections TEXT NOT NULL DEFAULT '[]',
  frequency TEXT NOT NULL DEFAULT 'weekly', -- 'daily' | 'weekly'
  weekly_day INTEGER NOT NULL DEFAULT 1,
  recipient_emails TEXT NOT NULL DEFAULT '',
  template TEXT NOT NULL DEFAULT 'classic', -- 'classic' | 'modern' | 'minimal'
  accent_color TEXT NOT NULL DEFAULT '#4f46e5',
  active INTEGER NOT NULL DEFAULT 1,
  last_sent_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scheduled_reports_client ON scheduled_reports(client_id);
