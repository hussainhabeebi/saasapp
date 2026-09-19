-- Add location field to hospitality_properties so properties can be grouped by destination.
-- When a lead selects a destination (e.g. "Munnar"), HospSelectedLocation is stored in the
-- lead record and the bot only shows/discusses properties from that location.
ALTER TABLE hospitality_properties ADD COLUMN location TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_hosp_props_location ON hospitality_properties(client_id, location);
