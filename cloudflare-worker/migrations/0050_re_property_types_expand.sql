-- Relaxes re_units.property_type's CHECK constraint (added in migrations/0049_re_unit_media.sql,
-- fixed to exactly Residential/Commercial/Villa/Flat/Plot) so new property types — starting with
-- "Shared Room" (co-living/PG-style sharing listings) — don't each require their own schema
-- migration. SQLite can't ALTER a CHECK constraint in place, so this is the standard SQLite
-- rebuild: new table with the same columns minus the CHECK, copy, swap. Validation of which values
-- are legal moves entirely to the app layer instead (RE_PROPERTY_TYPES in worker.js, plus each
-- client's own configured subset in CLIENTS.re_property_types_json) — same reasoning as every other
-- enum-ish field in this app (e.g. re_units.status) that was never a DB-level CHECK to begin with.
CREATE TABLE re_units_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  project_id INTEGER NOT NULL,
  tower TEXT NOT NULL DEFAULT '',
  floor INTEGER NOT NULL DEFAULT 0,
  unit_no TEXT NOT NULL,
  unit_type TEXT NOT NULL DEFAULT '',
  area_sqft REAL NOT NULL DEFAULT 0,
  base_price REAL NOT NULL DEFAULT 0,
  plc_charges REAL NOT NULL DEFAULT 0,
  floor_rise_charges REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'available',
  hold_expires_at TEXT,
  virtual_tour_url TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  image_url TEXT NOT NULL DEFAULT '',
  image_url_2 TEXT NOT NULL DEFAULT '',
  image_url_3 TEXT NOT NULL DEFAULT '',
  image_url_4 TEXT NOT NULL DEFAULT '',
  image_url_5 TEXT NOT NULL DEFAULT '',
  video_url TEXT NOT NULL DEFAULT '',
  pdf_url TEXT NOT NULL DEFAULT '',
  property_type TEXT NOT NULL DEFAULT ''
);
INSERT INTO re_units_new SELECT
  id, client_id, project_id, tower, floor, unit_no, unit_type, area_sqft, base_price, plc_charges,
  floor_rise_charges, status, hold_expires_at, virtual_tour_url, created_at, image_url, image_url_2,
  image_url_3, image_url_4, image_url_5, video_url, pdf_url, property_type
FROM re_units;
DROP TABLE re_units;
ALTER TABLE re_units_new RENAME TO re_units;
CREATE INDEX IF NOT EXISTS idx_re_units_client ON re_units(client_id);
CREATE INDEX IF NOT EXISTS idx_re_units_project ON re_units(project_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_re_units_unique ON re_units(project_id, tower, unit_no);
