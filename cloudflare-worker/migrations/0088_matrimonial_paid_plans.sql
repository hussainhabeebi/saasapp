ALTER TABLE matrimonial_settings ADD COLUMN paid_plans TEXT;
ALTER TABLE matrimonial_settings ADD COLUMN razorpay_key_id TEXT;
ALTER TABLE matrimonial_settings ADD COLUMN razorpay_key_secret TEXT;
ALTER TABLE matrimonial_settings ADD COLUMN razorpay_webhook_secret TEXT;
ALTER TABLE matrimonial_settings ADD COLUMN chat_keyword_plans TEXT DEFAULT '5';
ALTER TABLE matrimonial_activated_leads ADD COLUMN plan_type TEXT DEFAULT 'free';
ALTER TABLE matrimonial_activated_leads ADD COLUMN razorpay_payment_id TEXT;
