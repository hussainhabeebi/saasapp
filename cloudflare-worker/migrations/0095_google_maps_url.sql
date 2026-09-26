-- google_maps_url is stored in NocoDB (clients table), not in D1.
-- Column is created at runtime via ensureGoogleMapsUrlColumn() in dashboard.html.
-- This migration is intentionally a no-op.
SELECT 1;
