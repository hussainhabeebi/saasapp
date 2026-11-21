-- Settings → Integrations → Meta Ads → 📤 Report to Meta (worker metaCapiOutcomes): which lead
-- outcomes (Qualified Lead, Non Qualified, Won, Lost) go to Meta, and as which event. Kept in D1,
-- not on the NocoDB clients table, which couldn't always take a new column.
CREATE TABLE IF NOT EXISTS meta_capi_outcomes (
  client_id INTEGER PRIMARY KEY,
  config_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);
