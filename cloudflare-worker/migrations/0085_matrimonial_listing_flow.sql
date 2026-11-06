-- Adds listing_data column to store in-progress profile registration data
-- during the conversational WhatsApp profile listing flow (menu option "2")
ALTER TABLE matrimonial_chat_state ADD COLUMN listing_data TEXT;
