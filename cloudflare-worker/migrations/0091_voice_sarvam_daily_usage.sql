-- Caps paid Worker-level Sarvam fallback usage per client/day. Client-owned Sarvam keys bypass
-- this table because their usage is billed directly to that client.
CREATE TABLE IF NOT EXISTS voice_sarvam_daily_usage (
  client_id TEXT NOT NULL,
  usage_date TEXT NOT NULL,
  usage_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (client_id, usage_date)
);

CREATE INDEX IF NOT EXISTS idx_voice_sarvam_usage_date
  ON voice_sarvam_daily_usage (usage_date);
