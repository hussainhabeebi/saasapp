-- Per-client supplier credentials for Live Travel Agency.
-- credentials_encrypted contains AES-GCM ciphertext only; endpoint URLs are
-- tenant-specific configuration but are not authentication secrets.
-- NOTE: columns already exist in production; these ALTER TABLEs are skipped via
-- a SELECT no-op so re-running migrations on an existing DB does not error.
SELECT 1; -- columns credentials_encrypted and endpoints_json already added manually
