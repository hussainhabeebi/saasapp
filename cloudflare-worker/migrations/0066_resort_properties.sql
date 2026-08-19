-- Parent-level "properties" for resort-style hospitality (hospitality_style='resort').
-- Each unit in hospitality_units can belong to one property via property_id FK
-- (added in migration 0067). Properties hold their own 5-image + 2-video media catalog
-- and dedup their WhatsApp sends in hospitality_property_media_sent.
CREATE TABLE IF NOT EXISTS hospitality_properties (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  amenities TEXT NOT NULL DEFAULT '',
  image_url_1 TEXT,
  image_url_2 TEXT,
  image_url_3 TEXT,
  image_url_4 TEXT,
  image_url_5 TEXT,
  video_url_1 TEXT,
  video_url_2 TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hosp_props_client ON hospitality_properties(client_id);

-- Dedup tracker for property-level WhatsApp sends — mirrors hospitality_media_sent
-- but keyed on property_id instead of unit_id.
CREATE TABLE IF NOT EXISTS hospitality_property_media_sent (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  lead_id INTEGER NOT NULL,
  property_id INTEGER NOT NULL,
  sent_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hosp_prop_media_sent ON hospitality_property_media_sent(lead_id, property_id);
