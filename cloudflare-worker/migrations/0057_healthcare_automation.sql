-- Durable Healthcare appointment automation. Queue payloads contain IDs only; patient-facing
-- details are re-read from the client-scoped appointment row at delivery time.

CREATE TABLE IF NOT EXISTS healthcare_automation_settings (
  client_id INTEGER PRIMARY KEY,
  confirmation_template_name TEXT NOT NULL DEFAULT '',
  reminder_template_name TEXT NOT NULL DEFAULT '',
  template_language TEXT NOT NULL DEFAULT 'en',
  reminder_24h_enabled INTEGER NOT NULL DEFAULT 1,
  reminder_2h_enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS healthcare_appointment_automation (
  client_id INTEGER NOT NULL,
  appointment_id INTEGER NOT NULL,
  appointment_version TEXT NOT NULL DEFAULT '',
  workflow_instance_id TEXT NOT NULL DEFAULT '',
  workflow_status TEXT NOT NULL DEFAULT 'pending',
  calendar_status TEXT NOT NULL DEFAULT 'pending',
  reminder_status TEXT NOT NULL DEFAULT 'pending',
  last_error TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (client_id, appointment_id)
);
CREATE INDEX IF NOT EXISTS idx_healthcare_automation_status
  ON healthcare_appointment_automation(client_id, workflow_status, calendar_status, reminder_status);

CREATE TABLE IF NOT EXISTS healthcare_appointment_notifications (
  client_id INTEGER NOT NULL,
  appointment_id INTEGER NOT NULL,
  appointment_version TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'processing',
  sent_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  PRIMARY KEY (client_id, appointment_id, appointment_version, kind)
);

CREATE TABLE IF NOT EXISTS healthcare_queue_failures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL DEFAULT 0,
  appointment_id INTEGER NOT NULL DEFAULT 0,
  job_type TEXT NOT NULL DEFAULT '',
  failure_reason TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_healthcare_queue_failures_client
  ON healthcare_queue_failures(client_id, created_at);
