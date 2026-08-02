-- Recruitment & Consultancy module (SETUP.md "Recruitment module") — rebuilt on D1, replacing the
-- old per-client dynamic NocoDB tables (RC_Jobs_<id>/RC_Candidates_<id>/RC_Placements_<id>,
-- created client-side straight from the browser against NocoDB's Meta API on first use). That
-- design was the odd one out: every other module with this shape (Hospitality, Financial
-- Planning, B2B, Accounting, SaaS Ops) already uses one shared D1 table keyed by client_id, no
-- per-client schema provisioning step, no "Create Tables Now" onboarding click, no master NocoDB
-- token exposure risk from doing Meta API calls straight from the browser. This brings Recruitment
-- in line with that pattern. CLIENTS.recruit_table_ids (the old per-client table-id JSON) and the
-- rcSetupTables() onboarding flow are gone along with it — recruit_enabled is now the only gate.
CREATE TABLE IF NOT EXISTS recruit_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  company TEXT,
  location TEXT,
  job_type TEXT NOT NULL DEFAULT 'fulltime',
  category TEXT,
  min_salary REAL,
  max_salary REAL,
  currency TEXT NOT NULL DEFAULT 'AED',
  status TEXT NOT NULL DEFAULT 'open',
  min_age INTEGER,
  max_age INTEGER,
  min_experience INTEGER,
  required_qualifications TEXT,
  requirements TEXT,
  description TEXT,
  notes TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recruit_jobs_client ON recruit_jobs(client_id);

CREATE TABLE IF NOT EXISTS recruit_candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  role_applied TEXT,
  years_experience REAL,
  skills TEXT,
  current_salary REAL,
  expected_salary REAL,
  age INTEGER,
  job_id INTEGER,
  currency TEXT NOT NULL DEFAULT 'AED',
  status TEXT NOT NULL DEFAULT 'new',
  source TEXT NOT NULL DEFAULT 'whatsapp',
  owner TEXT,
  qualification_status TEXT,
  screening_notes TEXT,
  notes TEXT,
  resume_notes TEXT,
  interview_date TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recruit_candidates_client ON recruit_candidates(client_id);
CREATE INDEX IF NOT EXISTS idx_recruit_candidates_job ON recruit_candidates(client_id, job_id);

CREATE TABLE IF NOT EXISTS recruit_placements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  candidate_name TEXT NOT NULL,
  candidate_phone TEXT,
  job_title TEXT,
  client_company TEXT,
  placement_date TEXT,
  fee_amount REAL,
  currency TEXT NOT NULL DEFAULT 'AED',
  fee_type TEXT NOT NULL DEFAULT 'fixed',
  percentage REAL,
  status TEXT NOT NULL DEFAULT 'pending',
  notes TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recruit_placements_client ON recruit_placements(client_id);
