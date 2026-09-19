-- Dedicated public serial/reference used by the matrimonial WhatsApp lookup flow.
ALTER TABLE matrimonial_profiles ADD COLUMN serial_number TEXT;
CREATE INDEX IF NOT EXISTS idx_matri_profiles_serial ON matrimonial_profiles(client_id, serial_number);
