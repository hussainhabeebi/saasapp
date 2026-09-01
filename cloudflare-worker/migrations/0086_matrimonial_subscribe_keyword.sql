-- Adds a configurable keyword for the free-subscription menu option
-- in the matrimonial WhatsApp chat (default "4")
ALTER TABLE matrimonial_settings ADD COLUMN chat_keyword_subscribe TEXT DEFAULT '4';
