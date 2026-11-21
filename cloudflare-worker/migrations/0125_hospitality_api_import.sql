-- Hospitality → API Import: pull properties and units from another system's REST API (e.g. a
-- property site's "/api/v1/properties" with an API key) and keep them in sync on the 15-minute
-- cron. See hospitality-import.js. The same DDL is also run lazily by the worker
-- (hiEnsureSchema), so the feature works before this file is applied.
--
-- One row per API link a client adds. The key is stored encrypted (AI_KEY_ENC_SECRET, same as AI
-- provider keys) and only ever sent to the link's own origin.
CREATE TABLE IF NOT EXISTS hospitality_api_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL,
  auth_style TEXT NOT NULL DEFAULT 'bearer',
  api_key_enc TEXT NOT NULL DEFAULT '',
  key_hint TEXT NOT NULL DEFAULT '',
  sync_enabled INTEGER NOT NULL DEFAULT 1,
  sync_minutes INTEGER NOT NULL DEFAULT 60,
  last_sync_at TEXT,
  last_status TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  last_summary TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_hosp_api_sources_client ON hospitality_api_sources(client_id);

-- Which local hospitality_properties / hospitality_units row each remote record became. Kept out
-- of those tables so no existing table changes shape. `hash` skips writes when nothing changed;
-- `removed` marks rows the sync switched off because they left the feed (switched back on if they
-- return).
CREATE TABLE IF NOT EXISTS hospitality_api_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  source_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  external_id TEXT NOT NULL,
  local_id INTEGER NOT NULL,
  hash TEXT NOT NULL DEFAULT '',
  removed INTEGER NOT NULL DEFAULT 0,
  seen_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hosp_api_links_ext ON hospitality_api_links(source_id, kind, external_id);
CREATE INDEX IF NOT EXISTS idx_hosp_api_links_local ON hospitality_api_links(client_id, kind, local_id);
