-- Hospitality unit media (2-3 photos + 1 video per unit — SETUP.md "Hospitality module") and a log
-- of which lead has already been sent which unit's media, so the auto-send only fires once per
-- lead/unit rather than on every message that mentions it. Actual bytes live in R2
-- (HOSPITALITY_MEDIA binding) — these columns just hold this Worker's own serving URL
-- (/hospitality/media/<key>), the same "store a reference, fetch bytes at send time" pattern
-- engineSendChatwootImageReply already uses for ecommerce product images.
ALTER TABLE hospitality_units ADD COLUMN image_url_1 TEXT;
ALTER TABLE hospitality_units ADD COLUMN image_url_2 TEXT;
ALTER TABLE hospitality_units ADD COLUMN image_url_3 TEXT;
ALTER TABLE hospitality_units ADD COLUMN video_url TEXT;

CREATE TABLE IF NOT EXISTS hospitality_media_sent (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  lead_id INTEGER NOT NULL,
  unit_id INTEGER NOT NULL,
  sent_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hosp_media_sent_unique ON hospitality_media_sent(lead_id, unit_id);
