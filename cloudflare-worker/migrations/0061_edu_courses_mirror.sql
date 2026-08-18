-- Durable backup of education course writes. NocoDB stays the source of truth that education.html
-- reads from — this is a mirror only, upserted right after a course is saved to NocoDB, so a
-- client whose NocoDB base gets misconfigured or wiped still has course data recoverable from D1.
CREATE TABLE IF NOT EXISTS edu_courses_mirror (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  nocodb_id INTEGER NOT NULL,
  name TEXT,
  short_label TEXT,
  category TEXT,
  level TEXT,
  duration TEXT,
  price REAL,
  currency TEXT,
  seats_available INTEGER,
  start_date TEXT,
  status TEXT,
  enrollment_link TEXT,
  image_url TEXT,
  image_url_2 TEXT,
  image_url_3 TEXT,
  audio_url TEXT,
  video_url TEXT,
  pdf_url TEXT,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_edu_courses_mirror_unique ON edu_courses_mirror(client_id, nocodb_id);
