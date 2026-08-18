-- Education Scholarships & Offers (Education → 🎁 Scholarships tab) — lets an institution define
-- scholarship/promo codes with a description, a dedicated reply, which courses it applies to
-- (optional — blank means all courses), and Google Drive-linked image/audio/video.
-- engineEduMaybeSendScholarshipOffer (worker.js) matches a student's message against active codes
-- or generic "scholarship/discount/offer" wording and replies with reply_text plus any media.
CREATE TABLE IF NOT EXISTS edu_promotions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  code TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  reply_text TEXT NOT NULL DEFAULT '',
  course_ids TEXT NOT NULL DEFAULT '[]',  -- JSON array of course NocoDB Ids; [] = applies to all courses
  image_url TEXT,
  audio_url TEXT,
  video_url TEXT,
  status TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'inactive'
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_edu_promotions_client_code ON edu_promotions(client_id, code);
CREATE INDEX IF NOT EXISTS idx_edu_promotions_client ON edu_promotions(client_id, status);
