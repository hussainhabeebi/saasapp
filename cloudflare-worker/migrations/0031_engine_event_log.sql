-- Per-conversation engine event log (SETUP.md "Engine event log — Settings → Logs") — every time
-- handleEngineWebhook (worker.js) goes silent on an inbound WhatsApp message instead of replying,
-- one row lands here with the exact reason (rate-limited, duplicate delivery, handed over to a
-- human, etc). Successful turns are NOT duplicated here — those already land in
-- ENGINE_ANALYTICS_TABLE (NocoDB, see engineLogAnalytics), which the new /engine/logs endpoint
-- reads alongside this table to build one merged per-conversation timeline. Sidecar data with no
-- other reader in the app, same rationale as every other D1 table in this repo (see
-- migrations/0001_reviews_referrals.sql's own comment on that split).
CREATE TABLE IF NOT EXISTS engine_event_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  phone TEXT,
  conv_id TEXT,
  reason TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_engine_event_log_client_time ON engine_event_log(client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_engine_event_log_phone ON engine_event_log(client_id, phone, created_at DESC);
