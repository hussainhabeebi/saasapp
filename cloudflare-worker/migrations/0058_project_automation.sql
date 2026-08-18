-- Durable Project task automation. Queue and Workflow payloads contain identifiers and versions
-- only; task titles, descriptions and recipient addresses are always re-read from client-scoped D1.

ALTER TABLE pm_projects ADD COLUMN task_reminders_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pm_projects ADD COLUMN overdue_escalation_enabled INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS pm_task_automation (
  client_id INTEGER NOT NULL,
  project_id INTEGER NOT NULL,
  task_id INTEGER NOT NULL,
  task_version TEXT NOT NULL DEFAULT '',
  workflow_instance_id TEXT NOT NULL DEFAULT '',
  workflow_status TEXT NOT NULL DEFAULT 'pending',
  reminder_status TEXT NOT NULL DEFAULT 'pending',
  last_error TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (client_id, task_id)
);
CREATE INDEX IF NOT EXISTS idx_pm_task_automation_status
  ON pm_task_automation(client_id, project_id, workflow_status, reminder_status);

CREATE TABLE IF NOT EXISTS pm_task_notifications (
  client_id INTEGER NOT NULL,
  task_id INTEGER NOT NULL,
  task_version TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'processing',
  sent_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  PRIMARY KEY (client_id, task_id, task_version, kind)
);

CREATE TABLE IF NOT EXISTS pm_queue_failures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL DEFAULT 0,
  project_id INTEGER NOT NULL DEFAULT 0,
  task_id INTEGER NOT NULL DEFAULT 0,
  job_type TEXT NOT NULL DEFAULT '',
  failure_reason TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pm_queue_failures_client
  ON pm_queue_failures(client_id, created_at);
