-- Real Estate unit-level media (frontend/real-estate.html unit Add/Edit modal) — brings re_units up
-- to the same "5 images + video + PDF" shape ecom products already have (see ecom_products_mirror,
-- migrations/0043) and Hospitality units already have (migrations/0010). Same zero-storage-cost
-- design as ecom: merchants paste a Google Drive share link ("Anyone with the link can view") rather
-- than uploading a file, and sendDriveMediaToChatwoot (worker.js) resolves/forwards it on send — no
-- new R2 bucket needed.
ALTER TABLE re_units ADD COLUMN image_url TEXT NOT NULL DEFAULT '';
ALTER TABLE re_units ADD COLUMN image_url_2 TEXT NOT NULL DEFAULT '';
ALTER TABLE re_units ADD COLUMN image_url_3 TEXT NOT NULL DEFAULT '';
ALTER TABLE re_units ADD COLUMN image_url_4 TEXT NOT NULL DEFAULT '';
ALTER TABLE re_units ADD COLUMN image_url_5 TEXT NOT NULL DEFAULT '';
ALTER TABLE re_units ADD COLUMN video_url TEXT NOT NULL DEFAULT '';
ALTER TABLE re_units ADD COLUMN pdf_url TEXT NOT NULL DEFAULT '';

-- Top-level property category, distinct from the existing free-text unit_type (which stays for
-- finer detail like "2BHK"/"3BHK") — constrained so it can be used as a reliable filter/facet in
-- the frontend, unlike unit_type's freeform text.
ALTER TABLE re_units ADD COLUMN property_type TEXT NOT NULL DEFAULT ''
  CHECK(property_type IN ('', 'Residential', 'Commercial', 'Villa', 'Flat', 'Plot'));

-- Mirrors hospitality_media_sent (migrations/0010_hospitality_media.sql) — dedupe table so
-- engineMaybeSendRealEstateMedia (worker.js) sends a given unit's media to a given lead over chat
-- only once ever, not on every later message that happens to mention the same unit/project again.
CREATE TABLE IF NOT EXISTS re_media_sent (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  lead_id INTEGER NOT NULL,
  unit_id INTEGER NOT NULL,
  sent_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_re_media_sent_unique ON re_media_sent(lead_id, unit_id);
