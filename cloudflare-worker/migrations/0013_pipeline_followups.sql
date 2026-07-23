-- Advanced Pipeline module — escalating follow-up cadence tracking (SETUP.md "Advanced Pipeline
-- follow-up cadence"). One row per lead, tracking how far the auto-generated follow-up-task
-- cadence has advanced since the lead last entered its *current* Stage. Sidecar D1 state with no
-- NocoDB reader, same reasoning as every other D1 table in this file (Review Request/Referral/
-- Coach signals/Follow-up Engine) — the actual follow-up *tasks* themselves still live in the
-- existing manual_tasks CLIENTS field, this table only tracks cadence progress.
CREATE TABLE IF NOT EXISTS pipeline_followups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  lead_id INTEGER NOT NULL,
  stage TEXT NOT NULL,
  stage_entered_at TEXT NOT NULL,
  step INTEGER NOT NULL DEFAULT 0,
  cold INTEGER NOT NULL DEFAULT 0,
  channel TEXT NOT NULL DEFAULT 'whatsapp',
  last_task_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_followups_lead ON pipeline_followups(lead_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_followups_client ON pipeline_followups(client_id);
