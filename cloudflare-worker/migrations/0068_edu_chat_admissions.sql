-- Course-level controls used by the chat admission flow.
ALTER TABLE edu_courses ADD COLUMN admission_open INTEGER NOT NULL DEFAULT 1;
ALTER TABLE edu_courses ADD COLUMN eligibility_qualification TEXT NOT NULL DEFAULT '';
ALTER TABLE edu_courses ADD COLUMN required_documents_json TEXT NOT NULL DEFAULT '["id_proof","qualification_certificate","passport_photo"]';
ALTER TABLE edu_courses ADD COLUMN admission_fee REAL;
ALTER TABLE edu_courses ADD COLUMN payment_link TEXT NOT NULL DEFAULT '';

-- Persistent Education chat-only admission workflow (migration 0068)
-- One resumable application per student phone and course, plus documents and audit events.

CREATE TABLE IF NOT EXISTS edu_admission_applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  application_id TEXT NOT NULL,
  lead_id TEXT NOT NULL DEFAULT '',
  conversation_id TEXT NOT NULL DEFAULT '',
  student_id INTEGER,
  course_id INTEGER,
  phone TEXT NOT NULL,
  full_name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  qualification TEXT NOT NULL DEFAULT '',
  completion_year TEXT NOT NULL DEFAULT '',
  study_mode TEXT NOT NULL DEFAULT '',
  scholarship_code TEXT NOT NULL DEFAULT '',
  eligibility_status TEXT NOT NULL DEFAULT 'pending',
  current_step TEXT NOT NULL DEFAULT 'welcome',
  paused_step TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'in_progress',
  payment_option TEXT NOT NULL DEFAULT '',
  payment_status TEXT NOT NULL DEFAULT 'pending',
  payment_reference TEXT NOT NULL DEFAULT '',
  answers_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  submitted_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_edu_admission_application_id
  ON edu_admission_applications(client_id, application_id);
CREATE INDEX IF NOT EXISTS idx_edu_admission_phone
  ON edu_admission_applications(client_id, phone, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_edu_admission_course
  ON edu_admission_applications(client_id, course_id, status);

CREATE TABLE IF NOT EXISTS edu_admission_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  application_id INTEGER NOT NULL,
  document_type TEXT NOT NULL,
  file_url TEXT NOT NULL,
  media_type TEXT NOT NULL DEFAULT '',
  verification_status TEXT NOT NULL DEFAULT 'pending',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(application_id, document_type)
);
CREATE INDEX IF NOT EXISTS idx_edu_admission_documents_app
  ON edu_admission_documents(client_id, application_id);

CREATE TABLE IF NOT EXISTS edu_admission_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  application_id INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  step TEXT NOT NULL DEFAULT '',
  event_data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_edu_admission_events_app
  ON edu_admission_events(client_id, application_id, created_at);
