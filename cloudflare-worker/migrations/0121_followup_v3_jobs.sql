-- Health and delivery columns are added idempotently by fv3EnsureSchema at runtime so existing
-- installations that already created V3 lazily can migrate without duplicate-column failures.
CREATE TABLE IF NOT EXISTS followup_v3_jobs (
  client_id INTEGER NOT NULL,
  lead_id INTEGER NOT NULL,
  cycle TEXT NOT NULL,
  step INTEGER NOT NULL,
  status TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (client_id, lead_id, cycle, step)
);
CREATE INDEX IF NOT EXISTS idx_followup_v3_jobs_status ON followup_v3_jobs(client_id, status);
