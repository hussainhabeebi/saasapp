-- Add Google Maps URL field to CLIENTS so bots can share an actual link
-- when customers ask for directions or the shop location.
ALTER TABLE clients ADD COLUMN google_maps_url TEXT NOT NULL DEFAULT '';
