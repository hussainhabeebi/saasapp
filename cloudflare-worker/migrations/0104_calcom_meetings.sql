-- Cal.com Meetings (Settings → Integrations → 📞 Cal.com Meetings). Separate from the Appointment
-- Booking module and its own Cal.com Sync (appt_table_ids.bookings, handleCalcomWebhook) — nothing
-- here reads or writes those. The module is off for a client until they save at least one meeting
-- link; no row in meetings_config means no behaviour change for any existing client.
CREATE TABLE IF NOT EXISTS meetings_config (
  client_id INTEGER PRIMARY KEY,
  links_json TEXT NOT NULL DEFAULT '[]',     -- [{name, url}] — the client's own Cal.com event links
  webhook_secret TEXT,                        -- pasted into their Cal.com webhook; verifies X-Cal-Signature-256
  settings_json TEXT NOT NULL DEFAULT '{}',   -- confirm/remind24/remind1/nudge/cancel_followup/bot_share/template_name/template_lang
  last_event_at TEXT,                         -- last signed webhook received (incl. Cal.com's PING test)
  last_event_type TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- One row per meeting: created either when a rep sends a tracked link (status link_sent → clicked
-- → scheduled) or directly by the webhook for a booking that arrived without one (e.g. the bot
-- shared the plain link).
CREATE TABLE IF NOT EXISTS meetings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  token TEXT,                                 -- random, for the public /m/<token> click-tracking redirect
  lead_id INTEGER,
  lead_name TEXT,
  phone TEXT,                                 -- digits only
  email TEXT,
  link_name TEXT,
  link_url TEXT,
  sent_by TEXT,
  sent_at TEXT,
  clicked_at TEXT,
  calcom_uid TEXT,
  title TEXT,
  status TEXT NOT NULL,                       -- link_sent | clicked | pending | scheduled | cancelled | completed
  start_at TEXT,                              -- ISO UTC
  end_at TEXT,
  join_url TEXT,
  booked_at TEXT,
  confirm_at TEXT,
  remind24_at TEXT,
  remind1_at TEXT,
  nudge_at TEXT,
  outcome TEXT,                               -- interested | not_interested | follow_up | no_show
  outcome_note TEXT,
  outcome_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_meetings_token ON meetings(token) WHERE token IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_meetings_uid ON meetings(client_id, calcom_uid);
CREATE INDEX IF NOT EXISTS idx_meetings_status ON meetings(status, start_at);
CREATE INDEX IF NOT EXISTS idx_meetings_client_created ON meetings(client_id, created_at);
