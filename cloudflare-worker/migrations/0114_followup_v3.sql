-- Follow-up V3 (followup-v3.js) — a switch-on layer over the Follow-up Engine ladder
-- (followup_ladder_steps, migrations/0047/0048). Off until a client turns it on in Campaigns →
-- 💪 Follow-up Engine. followup-v3.js fv3EnsureSchema also creates all of this lazily, so a deploy
-- that hasn't run this migration still works.

-- One row per client that has ever touched the V3 switch. enabled_at = first switch-on; with
-- include_existing_leads off, only leads created after it are enrolled. config = JSON overrides of
-- FV3_DEFAULTS. maint_at = last hourly setup pass (seed ladder, submit/poll/attach templates).
CREATE TABLE IF NOT EXISTS followup_v3_settings (
  client_id INTEGER PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  enabled_at TEXT,
  config TEXT NOT NULL DEFAULT '{}',
  industry TEXT NOT NULL DEFAULT '',
  maint_at TEXT,
  last_digest_at TEXT,
  last_setup TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);

-- Per-lead V3 state: the sweep's latest decision (status/reason/next step + when — read by the
-- "Upcoming" list), skipped steps for the current silence (skip_json {cycle, steps}), retry/defer
-- after a failed send, and an hour-of-day histogram of the lead's own messages (smart send time).
CREATE TABLE IF NOT EXISTS followup_v3_leads (
  lead_id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  next_step INTEGER,
  next_due_at TEXT,
  lead_name TEXT NOT NULL DEFAULT '',
  skip_json TEXT NOT NULL DEFAULT '{}',
  defer_until TEXT,
  retries INTEGER NOT NULL DEFAULT 0,
  hours_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_followup_v3_leads_client ON followup_v3_leads(client_id, next_due_at);

-- Templates V3 submitted to Meta on the client's behalf (kind s3/s4/s5/reengage). params = which
-- lead value fills each {{n}} ('name' | 'business' | 'interest').
CREATE TABLE IF NOT EXISTS followup_v3_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'en',
  status TEXT NOT NULL DEFAULT 'PENDING',
  params TEXT NOT NULL DEFAULT '[]',
  attempt INTEGER NOT NULL DEFAULT 1,
  error TEXT NOT NULL DEFAULT '',
  submitted_at TEXT NOT NULL,
  checked_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_followup_v3_templates_kind ON followup_v3_templates(client_id, kind);

-- followup_sends (migrations/0007) gains V3 columns: v3 = sent by V3; kind = ladder | objection |
-- reengage (step 6); converted_at/revenue = last-touch conversion credit (a replied follow-up within
-- 14 days before the lead was won / booked / ordered); opted_out_at = the follow-up the customer
-- answered with STOP.
-- NOTE: no ALTER TABLE here. fv3EnsureSchema (SEND_COLUMNS in followup-v3.js) adds these columns
-- itself on first use, so on production they already existed by the time this migration ran and
-- `ALTER TABLE … ADD COLUMN` failed with "duplicate column name: v3" — SQLite has no ADD COLUMN IF
-- NOT EXISTS. Same pattern as 0102_recruit_bot_screening_phrases.sql; fresh databases get the
-- columns from the worker.
CREATE INDEX IF NOT EXISTS idx_followup_sends_client_sent ON followup_sends(client_id, sent_at);
