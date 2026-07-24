-- Task Manager's Calendar module (SETUP.md "Calendar events") — dedupe log for the auto-send
-- cron. The events themselves live in the existing CLIENTS.calendar_events JSON field (same
-- "config blob on CLIENTS" pattern as automation_flows/manual_tasks); this table only tracks which
-- (event, lead, occurrence) combinations have already been sent, so a recurring yearly event (a
-- Birthday, say) sends exactly once per occurrence instead of every day the cron happens to run
-- past its date, and a segment event sends to each matching lead exactly once per occurrence.
CREATE TABLE IF NOT EXISTS calendar_event_sends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  lead_id INTEGER NOT NULL,
  occurrence_key TEXT NOT NULL,
  sent_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_event_sends_unique ON calendar_event_sends(event_id, lead_id, occurrence_key);
CREATE INDEX IF NOT EXISTS idx_calendar_event_sends_client ON calendar_event_sends(client_id);
