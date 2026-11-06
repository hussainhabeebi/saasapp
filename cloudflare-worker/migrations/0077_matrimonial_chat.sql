-- Chat menu settings for the matrimonial WhatsApp bot
ALTER TABLE matrimonial_settings ADD COLUMN chat_enabled INTEGER DEFAULT 0;
ALTER TABLE matrimonial_settings ADD COLUMN chat_welcome_message TEXT;
ALTER TABLE matrimonial_settings ADD COLUMN chat_plan_filter TEXT DEFAULT '["gold","silver","platinum"]';
ALTER TABLE matrimonial_settings ADD COLUMN chat_profiles_per_msg INTEGER DEFAULT 3;
ALTER TABLE matrimonial_settings ADD COLUMN chat_preview_fields TEXT DEFAULT '["full_name","age","city","plan_label"]';
ALTER TABLE matrimonial_settings ADD COLUMN chat_form_url TEXT;
ALTER TABLE matrimonial_settings ADD COLUMN chat_keyword_view TEXT DEFAULT '1';
ALTER TABLE matrimonial_settings ADD COLUMN chat_keyword_list TEXT DEFAULT '2';
ALTER TABLE matrimonial_settings ADD COLUMN chat_keyword_agent TEXT DEFAULT '3';

-- Per-conversation state for the matrimonial chat menu (tracks menu position, gender selection, sent profile IDs)
CREATE TABLE IF NOT EXISTS matrimonial_chat_state (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL,
  phone TEXT NOT NULL,
  menu_state TEXT DEFAULT 'menu',
  profile_type TEXT,
  sent_ids TEXT DEFAULT '[]',
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(client_id, phone)
);
CREATE INDEX IF NOT EXISTS idx_matri_chat_state ON matrimonial_chat_state(client_id, phone);
