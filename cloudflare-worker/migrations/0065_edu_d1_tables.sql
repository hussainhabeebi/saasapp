-- Move edu courses and enrollments to D1 (previously NocoDB-backed).
-- All education data now lives in D1 — no NocoDB table IDs required.

CREATE TABLE IF NOT EXISTS edu_courses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  short_label TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  level TEXT NOT NULL DEFAULT '',
  duration TEXT NOT NULL DEFAULT '',
  start_date TEXT NOT NULL DEFAULT '',
  price REAL,
  currency TEXT NOT NULL DEFAULT 'INR',
  seats_available INTEGER,
  status TEXT NOT NULL DEFAULT 'active',
  enrollment_link TEXT NOT NULL DEFAULT '',
  image_url TEXT NOT NULL DEFAULT '',
  image_url_2 TEXT NOT NULL DEFAULT '',
  image_url_3 TEXT NOT NULL DEFAULT '',
  audio_url TEXT NOT NULL DEFAULT '',
  video_url TEXT NOT NULL DEFAULT '',
  pdf_url TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_edu_courses_client ON edu_courses(client_id, status);

CREATE TABLE IF NOT EXISTS edu_enrollments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  enrollment_id TEXT NOT NULL DEFAULT '',
  enrollment_date TEXT NOT NULL DEFAULT '',
  student_name TEXT NOT NULL DEFAULT '',
  student_phone TEXT NOT NULL DEFAULT '',
  student_email TEXT NOT NULL DEFAULT '',
  course TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_edu_enrollments_client ON edu_enrollments(client_id, status);
