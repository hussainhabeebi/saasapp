-- Records every failed attempt to send a template follow-up step (steps 3-5, which require an
-- approved WhatsApp template and fire after the 24h customer-service window). Both the cron sweep
-- (classicFollowupProcessClient) and the Smart Follow-ups Durable Object (LeadFollowupAgent) write
-- here on failure so the Follow-up Engine dashboard can surface the error instead of silently
-- swallowing it. A row here does NOT prevent the next cron/DO tick from retrying — it is an audit
-- log only; the Lead's "Follow up N" NocoDB flag stays unset until the send actually succeeds.
-- The error_code field captures the Meta API error code when available (e.g. 131030 = template not
-- found, 131031 = unapproved template, 190 = expired token) to make triage self-service.
CREATE TABLE IF NOT EXISTS followup_send_failures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  lead_id INTEGER NOT NULL,
  step INTEGER NOT NULL,
  error_message TEXT NOT NULL DEFAULT '',
  error_code INTEGER,
  source TEXT NOT NULL DEFAULT 'cron',  -- 'cron' | 'do' (Durable Object)
  failed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_followup_send_failures_client ON followup_send_failures(client_id, failed_at);
CREATE INDEX IF NOT EXISTS idx_followup_send_failures_lead ON followup_send_failures(lead_id, step);
