-- Hot-lead staff alerts (Settings → 👥 User Management → 🔥 Hot Lead Alerts) and Meta Lead Ads
-- instant WhatsApp (Integrations → 📋 Facebook & Instagram Lead Forms). The Worker also creates
-- both tables lazily (hotAlertEnsureSchema / metaLeadgenEnsureSchema), so an un-migrated database
-- still works; this file keeps the schema documented and applied on fresh setups.

-- Every alert attempt (sent / failed / skipped). The per-lead cooldown reads the 'sent' rows.
CREATE TABLE IF NOT EXISTS hot_lead_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  lead_id INTEGER,
  recipient_email TEXT,
  recipient_phone TEXT,
  reason TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hot_lead_alerts_lead ON hot_lead_alerts(client_id, lead_id, created_at);

-- One row per Meta leadgen_id — inserted first as a claim so webhook retries never double-send.
CREATE TABLE IF NOT EXISTS meta_leadgen_events (
  leadgen_id TEXT PRIMARY KEY,
  client_id INTEGER,
  page_id TEXT,
  form_id TEXT,
  lead_id INTEGER,
  name TEXT,
  phone TEXT,
  status TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_meta_leadgen_events_client ON meta_leadgen_events(client_id, created_at);
