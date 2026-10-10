-- Extended columns for matrimonial_profiles to match Google Sheets fields

ALTER TABLE matrimonial_profiles ADD COLUMN age INTEGER;
ALTER TABLE matrimonial_profiles ADD COLUMN gender TEXT;
ALTER TABLE matrimonial_profiles ADD COLUMN phone TEXT;
ALTER TABLE matrimonial_profiles ADD COLUMN whatsapp TEXT;
ALTER TABLE matrimonial_profiles ADD COLUMN guardian_phone TEXT;
ALTER TABLE matrimonial_profiles ADD COLUMN marriage_status TEXT;
ALTER TABLE matrimonial_profiles ADD COLUMN required_education TEXT;
ALTER TABLE matrimonial_profiles ADD COLUMN body_type TEXT;
ALTER TABLE matrimonial_profiles ADD COLUMN district TEXT;
ALTER TABLE matrimonial_profiles ADD COLUMN job_place TEXT;
ALTER TABLE matrimonial_profiles ADD COLUMN expected_partner_age TEXT;
ALTER TABLE matrimonial_profiles ADD COLUMN expected_partner_dob TEXT;
ALTER TABLE matrimonial_profiles ADD COLUMN other_conditions TEXT;
ALTER TABLE matrimonial_profiles ADD COLUMN payment_amount TEXT;
ALTER TABLE matrimonial_profiles ADD COLUMN payment_link TEXT;
ALTER TABLE matrimonial_profiles ADD COLUMN whatsapp_filled TEXT;
ALTER TABLE matrimonial_profiles ADD COLUMN plan_label TEXT;
ALTER TABLE matrimonial_profiles ADD COLUMN remarks TEXT;
