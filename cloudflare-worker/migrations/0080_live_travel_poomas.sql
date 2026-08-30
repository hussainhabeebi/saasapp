-- POOMAS ticket API integration: hold_ref / checkout_url were added in an earlier deploy;
-- columns already exist so ALTER TABLE statements are omitted here to keep this migration idempotent.

-- POOMAS per-client settings table (may already exist if bridge was deployed first)
CREATE TABLE IF NOT EXISTS live_travel_poomas_settings (
  client_id INTEGER PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  api_base TEXT NOT NULL DEFAULT 'https://api.flypoomas.com',
  checkout_base TEXT NOT NULL DEFAULT 'https://flypoomas.com',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
