-- Follow-up Engine (frontend/broadcast.html "💪 Follow-up Engine" tab) — A/B message variants for
-- the classic follow-up sequence (CLIENTS followup_count/followup_hours/followup_messages,
-- Settings), each with its own optional time-limited incentive and social-proof line. Layered on
-- top of the existing classic sequence rather than replacing it: handleBroadcastFollowupSend
-- already decides *when* (step number) to send from followup_count/followup_hours; this only
-- decides *what* — up to two message variants per step, one picked at random each send, so a
-- client can compare which wording actually gets a reply. A client with no rows here just keeps
-- getting the plain followup_messages text exactly as before (fully backward compatible).
CREATE TABLE IF NOT EXISTS followup_variants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  step INTEGER NOT NULL,
  variant TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  cta TEXT NOT NULL DEFAULT '',
  incentive_text TEXT NOT NULL DEFAULT '',
  incentive_expires_hours INTEGER,
  social_proof INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_followup_variants_unique ON followup_variants(client_id, step, variant);

-- One row per follow-up actually sent through handleBroadcastFollowupSend — variant is 'A'/'B', or
-- 'legacy' for a client with no variants configured yet. replied_at is stamped by the engine
-- webhook the next time this lead sends any real message (see handleEngineWebhook), so
-- reply_rate = replied/sent per (step, variant) needs no other tracking.
CREATE TABLE IF NOT EXISTS followup_sends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  lead_id INTEGER NOT NULL,
  step INTEGER NOT NULL,
  variant TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  replied_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_followup_sends_client_step ON followup_sends(client_id, step, variant);
CREATE INDEX IF NOT EXISTS idx_followup_sends_lead ON followup_sends(lead_id, replied_at);
