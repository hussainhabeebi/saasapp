-- Education course categories (Education → 🏷️ Categories tab) — each category can carry up to
-- 3 photos, auto-sent to chat the first time a student's message names that category, separate
-- from the per-course brochure/image sent when a specific course is identified.
CREATE TABLE IF NOT EXISTS edu_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  image_url_1 TEXT,
  image_url_2 TEXT,
  image_url_3 TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_edu_categories_client ON edu_categories(client_id);

CREATE TABLE IF NOT EXISTS edu_category_media_sent (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  lead_id INTEGER NOT NULL,
  category_id INTEGER NOT NULL,
  sent_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_edu_category_media_sent_unique ON edu_category_media_sent(lead_id, category_id);
