-- POOMAS ticket API integration: hold_ref on bookings, checkout_url on offers
ALTER TABLE live_travel_bookings ADD COLUMN IF NOT EXISTS hold_ref TEXT NOT NULL DEFAULT '';
ALTER TABLE live_travel_offers ADD COLUMN IF NOT EXISTS checkout_url TEXT NOT NULL DEFAULT '';

-- POOMAS per-client settings table (may already exist if bridge was deployed first)
CREATE TABLE IF NOT EXISTS live_travel_poomas_settings (
  client_id INTEGER PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  api_base TEXT NOT NULL DEFAULT 'https://api.flypoomas.com',
  checkout_base TEXT NOT NULL DEFAULT 'https://flypoomas.com',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
