-- Gate the Financial Planning reminder sweep (fpSendRemindersForClient) on an assigned WhatsApp
-- template — the daily cron never runs inside a customer-initiated 24h session window, so a
-- plain-text send is expected to fail there; an approved template is the only reliable channel.
ALTER TABLE fp_config ADD COLUMN reminder_template_name TEXT;
ALTER TABLE fp_config ADD COLUMN reminder_template_category TEXT;
ALTER TABLE fp_config ADD COLUMN reminder_template_language TEXT;

-- One row per reminder attempt (sent/failed/skipped), so every reminder and 24h-window follow-up
-- is auditable instead of failing silently (previously: catch(e){} with nothing recorded anywhere).
CREATE TABLE IF NOT EXISTS fp_reminder_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  due_id INTEGER,
  status TEXT NOT NULL, -- sent | failed | skipped_no_template | skipped_no_lead | skipped_no_conversation
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fp_reminder_log_client ON fp_reminder_log(client_id, created_at);
CREATE INDEX IF NOT EXISTS idx_fp_reminder_log_due ON fp_reminder_log(due_id);

-- A due with nothing actually owed should never sit 'open' forever getting reminded on for
-- 0.00 — backfill existing rows; fpGenerateForClient/fpRecomputeDueStatus (worker.js) now also
-- seed/settle these as 'paid' going forward.
UPDATE fp_expected_dues SET status='paid' WHERE amount<=0 AND status IN ('open','partial');
