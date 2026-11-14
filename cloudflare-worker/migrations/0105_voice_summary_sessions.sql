-- End-of-session voice summary (Malayalam/Hindi). Live replies are always text; when a customer
-- sent a voice note, one row tracks that conversation until it has been idle long enough, then the
-- */15 cron asks the self-hosted voice service (Indic Parler-TTS, Piper backup) for a single spoken
-- summary. status: pending → queued → sent | failed | skipped. A new customer message while
-- pending/queued pushes last_inbound_at forward and cancels any in-flight job.
CREATE TABLE IF NOT EXISTS voice_summary_sessions (
  client_id TEXT NOT NULL,
  conv_id TEXT NOT NULL,
  lead_id INTEGER NOT NULL,
  lang TEXT NOT NULL,
  started_at TEXT NOT NULL,
  last_inbound_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  job_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  queued_at TEXT,
  summary_text TEXT,
  provider TEXT,
  error TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (client_id, conv_id)
);

CREATE INDEX IF NOT EXISTS idx_voice_summary_due
  ON voice_summary_sessions (status, last_inbound_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_voice_summary_job
  ON voice_summary_sessions (job_id);
