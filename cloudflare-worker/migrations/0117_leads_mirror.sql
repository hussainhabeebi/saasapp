-- Leads read mirror (leads-mirror.js). NocoDB stays the source of truth; this is a read copy of
-- each enabled client's leads (every column but ConvHistory, as JSON in `row`) that answers the
-- dashboard's lead-list reads. Switched on with the LEADS_MIRROR var ("all" or "7,12"). The module
-- also creates these lazily, so a deploy that hasn't run this still works.
CREATE TABLE IF NOT EXISTS leads_mirror (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL DEFAULT 0,
  gen INTEGER NOT NULL DEFAULT 0,
  row TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_leads_mirror_client ON leads_mirror (client_id, updated_ms);

-- One row per client: pending → ready (or stale / error / too_big). cursor_ms is the newest
-- UpdatedAt the copy has seen; columns is the field list the copy holds.
CREATE TABLE IF NOT EXISTS leads_mirror_state (
  client_id INTEGER PRIMARY KEY,
  status TEXT NOT NULL,
  gen INTEGER NOT NULL DEFAULT 0,
  cursor_ms INTEGER NOT NULL DEFAULT 0,
  columns TEXT NOT NULL DEFAULT '[]',
  started_at TEXT,
  synced_at TEXT,
  error TEXT
);
