-- Education student success stories (Education → 🌟 Success Stories tab) — same shape as
-- ecom_testimonials (migrations/0046): client attaches a student name, a short testimonial text,
-- optional course links (JSON array of NocoDB course Ids; [] = all courses), and Google Drive
-- image/video. Displayed in the Stories tab; engine hook (engineMaybeSendEduScholarshipOffer
-- pattern) can surface them in chat on demand. `status` active/inactive mirrors ecom_testimonials.
CREATE TABLE IF NOT EXISTS edu_stories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  student_name TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  course_ids TEXT NOT NULL DEFAULT '[]',  -- JSON array of NocoDB course Ids; [] = all courses
  image_url TEXT,
  video_url TEXT,
  status TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'inactive'
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_edu_stories_client ON edu_stories(client_id, status);
