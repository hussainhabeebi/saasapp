-- Adds city and age preference filters to the matrimonial chat state so the
-- profile-viewing flow can narrow results to a specific district/city and max age.
ALTER TABLE matrimonial_chat_state ADD COLUMN city_filter TEXT;
ALTER TABLE matrimonial_chat_state ADD COLUMN max_age INTEGER;
