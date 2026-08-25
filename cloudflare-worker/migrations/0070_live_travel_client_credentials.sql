-- Per-client supplier credentials for Live Travel Agency.
-- credentials_encrypted contains AES-GCM ciphertext only; endpoint URLs are
-- tenant-specific configuration but are not authentication secrets.
ALTER TABLE live_travel_suppliers ADD COLUMN credentials_encrypted TEXT NOT NULL DEFAULT '';
ALTER TABLE live_travel_suppliers ADD COLUMN endpoints_json TEXT NOT NULL DEFAULT '{}';
