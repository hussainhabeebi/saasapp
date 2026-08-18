-- Adds property FK for resort-style units, and expands media from 3 images/1 video to 5/2.
-- All columns nullable so existing hotel/houseboat units are unaffected.
ALTER TABLE hospitality_units ADD COLUMN property_id INTEGER;
ALTER TABLE hospitality_units ADD COLUMN image_url_4 TEXT;
ALTER TABLE hospitality_units ADD COLUMN image_url_5 TEXT;
ALTER TABLE hospitality_units ADD COLUMN video_url_2 TEXT;
CREATE INDEX IF NOT EXISTS idx_hosp_units_property ON hospitality_units(property_id);
