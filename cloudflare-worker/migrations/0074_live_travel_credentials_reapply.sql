-- Ensure credentials_encrypted and endpoints_json exist on live_travel_suppliers.
-- Migration 0070 was converted to a SELECT 1 no-op to avoid a duplicate-column error
-- on the production DB where those columns were already present. This migration adds
-- them back for any fresh DB (CI, local) that never received them.
--
-- PRODUCTION NOTE: If the production D1 DB already has these columns (it does),
-- mark this migration as applied BEFORE running wrangler migrations apply --remote:
--   wrangler d1 execute leadvyne-d1 --remote \
--     --command "INSERT OR IGNORE INTO d1_migrations(name) VALUES('0074_live_travel_credentials_reapply.sql')"
ALTER TABLE live_travel_suppliers ADD COLUMN credentials_encrypted TEXT NOT NULL DEFAULT '';
ALTER TABLE live_travel_suppliers ADD COLUMN endpoints_json TEXT NOT NULL DEFAULT '{}';
