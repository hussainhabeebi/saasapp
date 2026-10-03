-- Webhook tokens and sync log for the Matrimonial module

ALTER TABLE matrimonial_settings ADD COLUMN profiles_webhook_token TEXT;
ALTER TABLE matrimonial_settings ADD COLUMN matches_webhook_token  TEXT;
ALTER TABLE matrimonial_settings ADD COLUMN shortlists_webhook_token TEXT;
ALTER TABLE matrimonial_settings ADD COLUMN stories_webhook_token  TEXT;

-- Column mappings: JSON objects mapping Google Sheets header → DB column for each table
ALTER TABLE matrimonial_settings ADD COLUMN profiles_col_map  TEXT DEFAULT '{}';
ALTER TABLE matrimonial_settings ADD COLUMN matches_col_map   TEXT DEFAULT '{}';
ALTER TABLE matrimonial_settings ADD COLUMN shortlists_col_map TEXT DEFAULT '{}';
ALTER TABLE matrimonial_settings ADD COLUMN stories_col_map   TEXT DEFAULT '{}';

-- Dedup key per table: the DB column used to upsert (e.g. "full_name" for profiles)
ALTER TABLE matrimonial_settings ADD COLUMN profiles_dedup_key  TEXT DEFAULT 'full_name';
ALTER TABLE matrimonial_settings ADD COLUMN matches_dedup_key   TEXT DEFAULT '';
ALTER TABLE matrimonial_settings ADD COLUMN shortlists_dedup_key TEXT DEFAULT '';
ALTER TABLE matrimonial_settings ADD COLUMN stories_dedup_key   TEXT DEFAULT '';

CREATE TABLE IF NOT EXISTS matrimonial_webhook_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id   TEXT NOT NULL,
  table_name  TEXT NOT NULL,
  rows_received INTEGER DEFAULT 0,
  rows_inserted INTEGER DEFAULT 0,
  rows_updated  INTEGER DEFAULT 0,
  rows_skipped  INTEGER DEFAULT 0,
  status      TEXT DEFAULT 'ok',
  error       TEXT,
  fired_at    TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_matri_wh_log ON matrimonial_webhook_log(client_id, table_name, fired_at DESC);
