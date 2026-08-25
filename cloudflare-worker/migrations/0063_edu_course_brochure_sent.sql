-- Per-day-per-course dedup for course image/brochure/video bundle sends (Education module).
-- Same pattern as ecom_product_image_sent (migrations/0055): a student asking about the same
-- course several times in one day gets the full image/brochure/video bundle only on the first
-- ask that day, not on every repeat — only same-day repeats are blocked, so the bundle happily
-- sends again on subsequent days. `sent_date` (not "ever") is the deliberate choice, same
-- reasoning as the ecom version.
CREATE TABLE IF NOT EXISTS edu_course_brochure_sent (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  lead_id INTEGER NOT NULL,
  course_id TEXT NOT NULL,
  sent_date TEXT NOT NULL,
  sent_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_edu_course_brochure_sent_unique ON edu_course_brochure_sent(client_id, lead_id, course_id, sent_date);
